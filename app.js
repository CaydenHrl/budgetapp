// ============================================================================
// Our Ledger — joint expense tracker
// Data lives as JSON files in a private GitHub repo, read/written via the
// GitHub Contents API. No build step, no server — just this static app.
// ============================================================================

const WHO_DEFS = [
  { key: "joint", label: "Joint", varName: "--who-joint" },
  { key: "kenzie", label: "Kenzie", varName: "--who-kenzie" },
  { key: "cayden", label: "Cayden", varName: "--who-cayden" },
];

const DEFAULT_CATEGORIES = [
  "Groceries", "Dining & Takeout", "Bills & Utilities", "Subscriptions",
  "Transportation", "Health & Fitness", "Shopping", "Entertainment",
  "Home", "Other",
];

const LS_SETTINGS = "ledger_settings_v1";
const LS_CACHE_EXPENSES = "ledger_cache_expenses_v1";
const LS_CACHE_CATEGORIES = "ledger_cache_categories_v1";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let settings = loadSettings();
let categories = [];
let categoriesSha = null;
let expenses = [];
let expensesSha = null;
let viewDate = startOfMonth(new Date());
let editingEntryId = null;
let selectedWho = settings.defaultWho || "joint";
let selectedWhy = null;

const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

// ---------------------------------------------------------------------------
// Settings persistence (per-device, localStorage)
// ---------------------------------------------------------------------------
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettingsToStorage() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
}

function settingsComplete() {
  return !!(settings.owner && settings.repo && settings.token);
}

// ---------------------------------------------------------------------------
// Base64 helpers (UTF-8 safe — GitHub's Contents API speaks base64)
// ---------------------------------------------------------------------------
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// GitHub Contents API
// ---------------------------------------------------------------------------
function apiUrl(path) {
  return `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${settings.token}`,
    Accept: "application/vnd.github+json",
  };
}

async function ghGetFile(path) {
  const branch = settings.branch || "main";
  const res = await fetch(`${apiUrl(path)}?ref=${encodeURIComponent(branch)}`, {
    headers: ghHeaders(),
  });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  const json = await res.json();
  const text = b64ToUtf8(json.content);
  return { data: JSON.parse(text), sha: json.sha };
}

async function ghWriteFile(path, dataObj, currentSha, message, attempt = 0) {
  const body = {
    message,
    content: utf8ToB64(JSON.stringify(dataObj, null, 2)),
    branch: settings.branch || "main",
  };
  if (currentSha) body.sha = currentSha;

  const res = await fetch(apiUrl(path), {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok && (res.status === 409 || res.status === 422) && attempt < 3) {
    // Someone else (or the other phone) wrote first — refetch sha and retry.
    const { sha } = await ghGetFile(path);
    return ghWriteFile(path, dataObj, sha, message, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`GitHub write failed (${res.status}) ${errText}`);
  }

  const json = await res.json();
  return json.content.sha;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------
let statusTimer = null;
function showStatus(msg, kind) {
  const el = document.getElementById("statusLine");
  el.textContent = msg;
  el.hidden = false;
  el.className = "status-line" + (kind ? " " + kind : "");
  clearTimeout(statusTimer);
  if (kind === "ok") {
    statusTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }
}

// ---------------------------------------------------------------------------
// Local cache (instant paint + light offline support)
// ---------------------------------------------------------------------------
function cacheLocally() {
  localStorage.setItem(LS_CACHE_EXPENSES, JSON.stringify({ data: expenses, sha: expensesSha }));
  localStorage.setItem(LS_CACHE_CATEGORIES, JSON.stringify({ data: categories, sha: categoriesSha }));
}

function loadFromCache() {
  try {
    const e = JSON.parse(localStorage.getItem(LS_CACHE_EXPENSES) || "null");
    const c = JSON.parse(localStorage.getItem(LS_CACHE_CATEGORIES) || "null");
    if (e) { expenses = e.data || []; expensesSha = e.sha; }
    if (c) { categories = c.data || []; categoriesSha = c.sha; }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadAllData() {
  if (!settingsComplete()) {
    openSettingsSheet(true);
    return;
  }
  loadFromCache();
  renderAll();

  showStatus("Syncing…");
  try {
    const [expRes, catRes] = await Promise.all([
      ghGetFile("data/expenses.json"),
      ghGetFile("data/categories.json"),
    ]);

    expenses = expRes.data || [];
    expensesSha = expRes.sha;

    const categoriesExisted = catRes.data !== null;
    categories = catRes.data || DEFAULT_CATEGORIES.slice();
    categoriesSha = catRes.sha;

    cacheLocally();
    renderAll();
    showStatus("Up to date", "ok");

    if (!categoriesExisted) {
      await persistCategories("Initialize categories");
    }
  } catch (err) {
    console.error(err);
    showStatus("Offline — showing last saved data", "error");
  }
}

async function persistExpenses(message) {
  showStatus("Saving…");
  try {
    expensesSha = await ghWriteFile("data/expenses.json", expenses, expensesSha, message);
    cacheLocally();
    showStatus("Saved", "ok");
  } catch (err) {
    console.error(err);
    showStatus("Couldn't save — check your connection or token", "error");
  }
}

async function persistCategories(message) {
  try {
    categoriesSha = await ghWriteFile("data/categories.json", categories, categoriesSha, message);
    cacheLocally();
  } catch (err) {
    console.error(err);
    showStatus("Couldn't save categories — check your connection or token", "error");
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function toISODate(d) {
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}
function isSameMonth(isoDate, monthDate) {
  const d = new Date(isoDate + "T00:00:00");
  return d.getFullYear() === monthDate.getFullYear() && d.getMonth() === monthDate.getMonth();
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------
function entriesForMonth() {
  return expenses
    .filter((e) => isSameMonth(e.date, viewDate))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || "").localeCompare(a.createdAt || "")));
}

function computeMonthSummary(list) {
  const byWho = { joint: 0, kenzie: 0, cayden: 0 };
  const byCategory = {};
  let grandTotal = 0;

  for (const e of list) {
    const amt = Number(e.amount) || 0;
    grandTotal += amt;
    if (byWho[e.who] !== undefined) byWho[e.who] += amt;
    const cat = e.why || "Other";
    byCategory[cat] = (byCategory[cat] || 0) + amt;
  }

  const sortedCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  return { grandTotal, byWho, sortedCategories };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  document.getElementById("monthLabel").textContent = monthFmt.format(viewDate);

  const list = entriesForMonth();
  const summary = computeMonthSummary(list);

  renderReceipt(summary);
  renderEntries(list);
}

function renderReceipt(summary) {
  document.getElementById("grandTotal").textContent = moneyFmt.format(summary.grandTotal);

  const whoPills = document.getElementById("whoPills");
  whoPills.innerHTML = WHO_DEFS.map((w) => `
    <div class="who-pill">
      <span class="who-dot" style="background:var(${w.varName})"></span>
      <span>${w.label}</span>
      <span class="who-amount">${moneyFmt.format(summary.byWho[w.key] || 0)}</span>
    </div>
  `).join("");

  const catBreakdown = document.getElementById("catBreakdown");
  if (summary.sortedCategories.length === 0) {
    catBreakdown.innerHTML = `<div class="cat-empty">No expenses logged this month yet.</div>`;
    return;
  }
  const max = summary.sortedCategories[0][1] || 1;
  catBreakdown.innerHTML = summary.sortedCategories.map(([cat, amt]) => `
    <div class="cat-row">
      <div class="cat-row-top">
        <span class="cat-name">${escapeHtml(cat)}</span>
        <span class="cat-amount">${moneyFmt.format(amt)}</span>
      </div>
      <div class="cat-bar-track">
        <div class="cat-bar-fill" style="width:${Math.max(4, (amt / max) * 100)}%"></div>
      </div>
    </div>
  `).join("");
}

function renderEntries(list) {
  const container = document.getElementById("entriesList");
  const emptyState = document.getElementById("emptyState");

  if (list.length === 0) {
    container.innerHTML = "";
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const dateFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
  let html = "";
  let lastDate = null;

  for (const e of list) {
    if (e.date !== lastDate) {
      html += `<div class="date-group-label">${dateFmt.format(new Date(e.date + "T00:00:00"))}</div>`;
      lastDate = e.date;
    }
    const whoDef = WHO_DEFS.find((w) => w.key === e.who) || WHO_DEFS[0];
    html += `
      <div class="entry-row" data-id="${e.id}">
        <span class="entry-who-dot" style="background:var(${whoDef.varName})"></span>
        <div class="entry-main">
          <div class="entry-where">${escapeHtml(e.where)}</div>
          <div class="entry-meta">${escapeHtml(e.what)} · ${escapeHtml(e.why || "Other")}</div>
        </div>
        <div class="entry-amount">${moneyFmt.format(Number(e.amount) || 0)}</div>
      </div>
    `;
  }
  container.innerHTML = html;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------------
// Pill builders (shared between add-expense sheet and settings sheet)
// ---------------------------------------------------------------------------
function renderWhoPicker(containerId, selectedKey, onPick) {
  const el = document.getElementById(containerId);
  el.innerHTML = WHO_DEFS.map((w) => `
    <button type="button" class="pill ${w.key === selectedKey ? "selected" : ""}" data-who="${w.key}">
      <span class="pill-dot" style="background:var(${w.varName})"></span>${w.label}
    </button>
  `).join("");
  el.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      el.querySelectorAll(".pill").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      onPick(btn.dataset.who);
    });
  });
}

function renderCategoryPicker(containerId, selectedCat, onPick) {
  const el = document.getElementById(containerId);
  el.innerHTML = categories.map((cat) => `
    <button type="button" class="pill ${cat === selectedCat ? "selected" : ""}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>
  `).join("");
  el.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      el.querySelectorAll(".pill").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      onPick(btn.dataset.cat);
    });
  });
}

function renderCategoryManager() {
  const el = document.getElementById("s_categories");
  el.innerHTML = categories.map((cat) => `
    <button type="button" class="pill" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)} ✕</button>
  `).join("");
  el.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      categories = categories.filter((c) => c !== btn.dataset.cat);
      renderCategoryManager();
    });
  });
}

// ---------------------------------------------------------------------------
// Expense sheet (add / edit)
// ---------------------------------------------------------------------------
function openExpenseSheet(entry) {
  editingEntryId = entry ? entry.id : null;
  document.getElementById("expenseSheetTitle").textContent = entry ? "Edit expense" : "Log an expense";
  document.getElementById("deleteEntryBtn").hidden = !entry;

  document.getElementById("f_date").value = entry ? entry.date : toISODate(new Date());
  document.getElementById("f_where").value = entry ? entry.where : "";
  document.getElementById("f_what").value = entry ? entry.what : "";
  document.getElementById("f_amount").value = entry ? entry.amount : "";

  selectedWho = entry ? entry.who : (settings.defaultWho || "joint");
  selectedWhy = entry ? entry.why : null;

  renderWhoPicker("f_who", selectedWho, (val) => (selectedWho = val));
  renderCategoryPicker("f_why", selectedWhy, (val) => (selectedWhy = val));

  document.getElementById("expenseBackdrop").hidden = false;
}

function closeExpenseSheet() {
  document.getElementById("expenseBackdrop").hidden = true;
  editingEntryId = null;
}

async function handleExpenseSubmit(ev) {
  ev.preventDefault();
  const date = document.getElementById("f_date").value;
  const where = document.getElementById("f_where").value.trim();
  const what = document.getElementById("f_what").value.trim();
  const amount = parseFloat(document.getElementById("f_amount").value);

  if (!date || !where || !what || isNaN(amount) || amount < 0 || !selectedWhy) {
    showStatus("Fill in every field, including a category", "error");
    return;
  }

  if (editingEntryId) {
    const idx = expenses.findIndex((e) => e.id === editingEntryId);
    if (idx !== -1) {
      expenses[idx] = { ...expenses[idx], date, where, what, amount, who: selectedWho, why: selectedWhy };
    }
  } else {
    expenses.push({
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
      date, where, what, amount, who: selectedWho, why: selectedWhy,
      createdAt: new Date().toISOString(),
    });
  }

  renderAll();
  closeExpenseSheet();
  await persistExpenses(editingEntryId ? "Edit expense entry" : "Add expense entry");
}

async function handleDeleteEntry() {
  if (!editingEntryId) return;
  expenses = expenses.filter((e) => e.id !== editingEntryId);
  renderAll();
  closeExpenseSheet();
  await persistExpenses("Delete expense entry");
}

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------
function openSettingsSheet(forced) {
  document.getElementById("s_owner").value = settings.owner || "";
  document.getElementById("s_repo").value = settings.repo || "";
  document.getElementById("s_branch").value = settings.branch || "main";
  document.getElementById("s_token").value = settings.token || "";

  renderWhoPicker("s_defaultWho", settings.defaultWho || "joint", (val) => (settings.defaultWho = val));

  if (categories.length === 0) categories = DEFAULT_CATEGORIES.slice();
  renderCategoryManager();

  document.getElementById("cancelSettingsBtn").hidden = !!forced && !settingsComplete();
  document.getElementById("settingsBackdrop").hidden = false;
}

function closeSettingsSheet() {
  document.getElementById("settingsBackdrop").hidden = true;
}

async function handleSettingsSubmit(ev) {
  ev.preventDefault();
  const wasComplete = settingsComplete();
  const oldCategoriesJson = JSON.stringify(categories);

  settings.owner = document.getElementById("s_owner").value.trim();
  settings.repo = document.getElementById("s_repo").value.trim();
  settings.branch = document.getElementById("s_branch").value.trim() || "main";
  settings.token = document.getElementById("s_token").value.trim();
  saveSettingsToStorage();

  closeSettingsSheet();

  if (!wasComplete) {
    await loadAllData();
  } else {
    renderAll();
    if (JSON.stringify(categories) !== oldCategoriesJson) {
      await persistCategories("Update categories");
    }
    showStatus("Settings saved", "ok");
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.getElementById("prevMonth").addEventListener("click", () => {
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
  renderAll();
});

document.getElementById("nextMonth").addEventListener("click", () => {
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
  renderAll();
});

document.getElementById("addBtn").addEventListener("click", () => openExpenseSheet(null));
document.getElementById("cancelSheetBtn").addEventListener("click", closeExpenseSheet);
document.getElementById("expenseSheet").addEventListener("submit", handleExpenseSubmit);
document.getElementById("deleteEntryBtn").addEventListener("click", handleDeleteEntry);

document.getElementById("expenseBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "expenseBackdrop") closeExpenseSheet();
});

document.getElementById("entriesList").addEventListener("click", (e) => {
  const row = e.target.closest(".entry-row");
  if (!row) return;
  const entry = expenses.find((x) => x.id === row.dataset.id);
  if (entry) openExpenseSheet(entry);
});

document.getElementById("settingsBtn").addEventListener("click", () => openSettingsSheet(false));
document.getElementById("cancelSettingsBtn").addEventListener("click", closeSettingsSheet);
document.getElementById("settingsSheet").addEventListener("submit", handleSettingsSubmit);
document.getElementById("settingsBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "settingsBackdrop" && settingsComplete()) closeSettingsSheet();
});

document.getElementById("s_addCategoryBtn").addEventListener("click", () => {
  const input = document.getElementById("s_newCategory");
  const val = input.value.trim();
  if (val && !categories.includes(val)) {
    categories.push(val);
    renderCategoryManager();
  }
  input.value = "";
});

// ---------------------------------------------------------------------------
// Service worker registration
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadAllData();
