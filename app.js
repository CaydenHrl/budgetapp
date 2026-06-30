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
const LS_CACHE_BUDGETS = "ledger_cache_budgets_v1";

// Stable category color assignment (by position in the categories list, so
// a given category keeps its color across months even as rankings shift).
const CATEGORY_PALETTE = [
  "#C9A227", "#4FA68C", "#D97757", "#5B7FA6",
  "#8E6FA8", "#B5495B", "#6FA8A0", "#A8915B",
];
function getCategoryColor(catName) {
  const idx = categories.indexOf(catName);
  return CATEGORY_PALETTE[(idx < 0 ? 0 : idx) % CATEGORY_PALETTE.length];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let settings = loadSettings();
let categories = [];
let categoriesSha = null;
let budgets = {};
let budgetsSha = null;
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
  localStorage.setItem(LS_CACHE_BUDGETS, JSON.stringify({ data: budgets, sha: budgetsSha }));
}

function loadFromCache() {
  try {
    const e = JSON.parse(localStorage.getItem(LS_CACHE_EXPENSES) || "null");
    const c = JSON.parse(localStorage.getItem(LS_CACHE_CATEGORIES) || "null");
    const b = JSON.parse(localStorage.getItem(LS_CACHE_BUDGETS) || "null");
    if (e) { expenses = e.data || []; expensesSha = e.sha; }
    if (c) { categories = c.data || []; categoriesSha = c.sha; }
    if (b) { budgets = b.data || {}; budgetsSha = b.sha; }
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
    const [expRes, catRes, budRes] = await Promise.all([
      ghGetFile("data/expenses.json"),
      ghGetFile("data/categories.json"),
      ghGetFile("data/budgets.json"),
    ]);

    expenses = expRes.data || [];
    expensesSha = expRes.sha;

    const categoriesExisted = catRes.data !== null;
    categories = catRes.data || DEFAULT_CATEGORIES.slice();
    categoriesSha = catRes.sha;

    budgets = budRes.data || {};
    budgetsSha = budRes.sha;

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

async function persistBudgets(message) {
  try {
    budgetsSha = await ghWriteFile("data/budgets.json", budgets, budgetsSha, message);
    cacheLocally();
  } catch (err) {
    console.error(err);
    showStatus("Couldn't save budgets — check your connection or token", "error");
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
function daysInMonth(monthDate) {
  return new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
}
function shiftMonths(monthDate, n) {
  return new Date(monthDate.getFullYear(), monthDate.getMonth() + n, 1);
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------
function entriesForMonthDate(monthDate) {
  return expenses
    .filter((e) => isSameMonth(e.date, monthDate))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || "").localeCompare(a.createdAt || "")));
}
function entriesForMonth() {
  return entriesForMonthDate(viewDate);
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
  const prevList = entriesForMonthDate(shiftMonths(viewDate, -1));
  const prevSummary = computeMonthSummary(prevList);

  renderReceipt(summary, prevSummary);
  renderEntries(list);
}

function renderDeltaLine(summary, prevSummary) {
  const el = document.getElementById("deltaLine");
  if (prevSummary.grandTotal <= 0) {
    el.textContent = summary.grandTotal > 0 ? "No data for last month to compare" : "";
    el.className = "delta-line";
    return;
  }
  const diff = summary.grandTotal - prevSummary.grandTotal;
  const pct = Math.round((diff / prevSummary.grandTotal) * 100);
  const prevMonthName = monthFmt.format(shiftMonths(viewDate, -1)).split(" ")[0];
  if (diff === 0) {
    el.textContent = `Flat vs ${prevMonthName}`;
    el.className = "delta-line";
  } else if (diff > 0) {
    el.textContent = `▲ ${pct}% vs ${prevMonthName}`;
    el.className = "delta-line up";
  } else {
    el.textContent = `▼ ${Math.abs(pct)}% vs ${prevMonthName}`;
    el.className = "delta-line down";
  }
}

function renderDonut(summary) {
  const donut = document.getElementById("donutChart");
  const legend = document.getElementById("donutLegend");
  const topCatEl = document.getElementById("donutTopCat");

  if (summary.sortedCategories.length === 0 || summary.grandTotal <= 0) {
    donut.style.background = "var(--surface-raised)";
    legend.innerHTML = "";
    topCatEl.textContent = "—";
    return;
  }

  let cumulative = 0;
  const stops = summary.sortedCategories.map(([cat, amt]) => {
    const startPct = (cumulative / summary.grandTotal) * 100;
    cumulative += amt;
    const endPct = (cumulative / summary.grandTotal) * 100;
    return `${getCategoryColor(cat)} ${startPct}% ${endPct}%`;
  });
  donut.style.background = `conic-gradient(${stops.join(", ")})`;

  const [topCat, topAmt] = summary.sortedCategories[0];
  topCatEl.textContent = topCat;
  topCatEl.title = moneyFmt.format(topAmt);

  legend.innerHTML = summary.sortedCategories.slice(0, 6).map(([cat, amt]) => {
    const pct = Math.round((amt / summary.grandTotal) * 100);
    return `
      <div class="legend-item">
        <span class="legend-dot" style="background:${getCategoryColor(cat)}"></span>
        <span>${escapeHtml(cat)} ${pct}%</span>
      </div>
    `;
  }).join("");
}

function renderReceipt(summary, prevSummary) {
  document.getElementById("grandTotal").textContent = moneyFmt.format(summary.grandTotal);
  renderDeltaLine(summary, prevSummary);
  renderDonut(summary);

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
  catBreakdown.innerHTML = summary.sortedCategories.map(([cat, amt]) => {
    const cap = budgets[cat];
    let barClass = "";
    let note = "";
    let pctOfMax = (amt / max) * 100;
    if (cap > 0) {
      const pctOfCap = (amt / cap) * 100;
      note = `<span class="cat-budget-note"> / ${moneyFmt.format(cap)}</span>`;
      if (pctOfCap >= 100) barClass = "over";
      else if (pctOfCap >= 80) barClass = "warn";
      pctOfMax = Math.min(100, pctOfCap);
    }
    return `
      <div class="cat-row">
        <div class="cat-row-top">
          <span class="cat-name">${escapeHtml(cat)}</span>
          <span class="cat-amount">${moneyFmt.format(amt)}${note}</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill ${barClass}" style="width:${Math.max(4, pctOfMax)}%"></div>
        </div>
      </div>
    `;
  }).join("");
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
      renderBudgetInputs();
    });
  });
}

function renderBudgetInputs() {
  const el = document.getElementById("s_budgets");
  el.innerHTML = categories.map((cat) => `
    <div class="budget-row">
      <span>${escapeHtml(cat)}</span>
      <input type="number" inputmode="decimal" step="0.01" min="0" class="budget-input"
        data-cat="${escapeHtml(cat)}" placeholder="No cap" value="${budgets[cat] ?? ""}" />
    </div>
  `).join("");
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
  renderBudgetInputs();

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
  const oldBudgetsJson = JSON.stringify(budgets);

  settings.owner = document.getElementById("s_owner").value.trim();
  settings.repo = document.getElementById("s_repo").value.trim();
  settings.branch = document.getElementById("s_branch").value.trim() || "main";
  settings.token = document.getElementById("s_token").value.trim();
  saveSettingsToStorage();

  const newBudgets = {};
  document.querySelectorAll(".budget-input").forEach((input) => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) newBudgets[input.dataset.cat] = val;
  });
  budgets = newBudgets;

  closeSettingsSheet();

  if (!wasComplete) {
    await loadAllData();
  } else {
    renderAll();
    if (JSON.stringify(categories) !== oldCategoriesJson) {
      await persistCategories("Update categories");
    }
    if (JSON.stringify(budgets) !== oldBudgetsJson) {
      await persistBudgets("Update budgets");
    }
    showStatus("Settings saved", "ok");
  }
}

// ---------------------------------------------------------------------------
// Month in Review
// ---------------------------------------------------------------------------
function rankBarRow(rank, label, meta, amount, max, color) {
  const pct = max > 0 ? Math.max(4, (amount / max) * 100) : 4;
  return `
    <div class="rank-row">
      <span class="rank-num">${rank}.</span>
      <div class="rank-body">
        <div class="rank-top-row">
          <span class="rank-label">${escapeHtml(label)}${meta ? ` <span class="rank-meta">${escapeHtml(meta)}</span>` : ""}</span>
          <span class="rank-amount">${moneyFmt.format(amount)}</span>
        </div>
        <div class="rank-bar-track">
          <div class="rank-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>
    </div>
  `;
}

function openReviewSheet() {
  const list = entriesForMonth();
  const summary = computeMonthSummary(list);
  const prevList = entriesForMonthDate(shiftMonths(viewDate, -1));
  const prevSummary = computeMonthSummary(prevList);

  document.getElementById("reviewTitle").textContent = `${monthFmt.format(viewDate)} in Review`;

  // --- stats grid ---
  const days = daysInMonth(viewDate);
  const avgPerDay = summary.grandTotal / days;
  const merchantTotals = {};
  list.forEach((e) => { merchantTotals[e.where] = (merchantTotals[e.where] || 0) + (Number(e.amount) || 0); });
  const topMerchant = Object.entries(merchantTotals).sort((a, b) => b[1] - a[1])[0];

  let deltaText = "No prior month data";
  if (prevSummary.grandTotal > 0) {
    const diff = summary.grandTotal - prevSummary.grandTotal;
    const pct = Math.round((diff / prevSummary.grandTotal) * 100);
    deltaText = diff === 0 ? "Flat" : `${diff > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`;
  }

  document.getElementById("reviewStats").innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total spent</div>
      <div class="stat-value">${moneyFmt.format(summary.grandTotal)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Vs last month</div>
      <div class="stat-value">${deltaText}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Entries logged</div>
      <div class="stat-value">${list.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Avg per day</div>
      <div class="stat-value">${moneyFmt.format(avgPerDay)}</div>
    </div>
    <div class="stat-card wide">
      <div class="stat-label">Top merchant</div>
      <div class="stat-value">${topMerchant ? `${escapeHtml(topMerchant[0])} — ${moneyFmt.format(topMerchant[1])}` : "—"}</div>
    </div>
  `;

  // --- categories ranked ---
  const catEl = document.getElementById("reviewCategories");
  if (summary.sortedCategories.length === 0) {
    catEl.innerHTML = `<div class="cat-empty">Nothing logged this month.</div>`;
  } else {
    const maxCat = summary.sortedCategories[0][1];
    catEl.innerHTML = summary.sortedCategories
      .map(([cat, amt], i) => rankBarRow(i + 1, cat, null, amt, maxCat, getCategoryColor(cat)))
      .join("");
  }

  // --- top single purchases ---
  const purchasesEl = document.getElementById("reviewPurchases");
  const topPurchases = [...list].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 5);
  if (topPurchases.length === 0) {
    purchasesEl.innerHTML = `<div class="cat-empty">Nothing logged this month.</div>`;
  } else {
    const maxPurchase = Number(topPurchases[0].amount) || 1;
    const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
    purchasesEl.innerHTML = topPurchases
      .map((e, i) => rankBarRow(
        i + 1, e.where, `${e.what} · ${dateFmt.format(new Date(e.date + "T00:00:00"))}`,
        Number(e.amount) || 0, maxPurchase, "var(--brass)"
      ))
      .join("");
  }

  // --- who paid the most ---
  const whoEl = document.getElementById("reviewWho");
  const whoRanked = WHO_DEFS.map((w) => ({ ...w, amount: summary.byWho[w.key] || 0 }))
    .sort((a, b) => b.amount - a.amount);
  const maxWho = whoRanked[0].amount || 1;
  whoEl.innerHTML = whoRanked
    .map((w, i) => rankBarRow(i + 1, w.label, null, w.amount, maxWho, `var(${w.varName})`))
    .join("");

  // --- 6 month trend ---
  const trendEl = document.getElementById("reviewTrend");
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonths(viewDate, -i));
  const totals = months.map((m) => computeMonthSummary(entriesForMonthDate(m)).grandTotal);
  const maxTrend = Math.max(...totals, 1);
  const trendLabelFmt = new Intl.DateTimeFormat("en-US", { month: "short" });
  trendEl.innerHTML = months.map((m, i) => {
    const isCurrent = m.getFullYear() === viewDate.getFullYear() && m.getMonth() === viewDate.getMonth();
    const h = Math.max(4, (totals[i] / maxTrend) * 100);
    return `
      <div class="trend-col">
        <div class="trend-bar ${isCurrent ? "current" : ""}" style="height:${h}%" title="${moneyFmt.format(totals[i])}"></div>
        <div class="trend-label">${trendLabelFmt.format(m)}</div>
      </div>
    `;
  }).join("");

  document.getElementById("reviewBackdrop").hidden = false;
}

function closeReviewSheet() {
  document.getElementById("reviewBackdrop").hidden = true;
}

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------
function openImportSheet() {
  closeSettingsSheet();
  document.getElementById("i_text").value = "";
  const resultEl = document.getElementById("importResult");
  resultEl.hidden = true;
  document.getElementById("importBackdrop").hidden = false;
}

function closeImportSheet() {
  document.getElementById("importBackdrop").hidden = true;
}

function parseImportText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const validEntries = [];
  const errors = [];
  const newCategories = [];

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const fields = line.split("|").map((f) => f.trim());

    // skip an optional header row
    if (lineNum === 1 && fields[0] && fields[0].toLowerCase() === "date") return;

    if (fields.length !== 6) {
      errors.push(`Line ${lineNum}: expected 6 fields separated by "|", got ${fields.length}`);
      return;
    }
    const [date, where, what, whoRaw, whyRaw, amountRaw] = fields;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T00:00:00").getTime())) {
      errors.push(`Line ${lineNum}: bad date "${date}" — use YYYY-MM-DD`);
      return;
    }
    if (!where) { errors.push(`Line ${lineNum}: "where" is empty`); return; }
    if (!what) { errors.push(`Line ${lineNum}: "what" is empty`); return; }

    const who = whoRaw.toLowerCase();
    if (!WHO_DEFS.some((w) => w.key === who)) {
      errors.push(`Line ${lineNum}: "who" must be joint, kenzie, or cayden — got "${whoRaw}"`);
      return;
    }

    const amount = parseFloat(amountRaw.replace(/[^0-9.\-]/g, ""));
    if (isNaN(amount) || amount < 0) {
      errors.push(`Line ${lineNum}: bad amount "${amountRaw}"`);
      return;
    }

    if (!whyRaw) { errors.push(`Line ${lineNum}: "why" (category) is empty`); return; }
    let why = whyRaw;
    const existing = categories.find((c) => c.toLowerCase() === whyRaw.toLowerCase());
    if (existing) {
      why = existing;
    } else if (!newCategories.some((c) => c.toLowerCase() === whyRaw.toLowerCase())) {
      newCategories.push(whyRaw);
    }

    validEntries.push({
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
      date, where, what, amount, who, why,
      createdAt: new Date().toISOString(),
    });
  });

  return { validEntries, errors, newCategories };
}

async function handleImportSubmit(ev) {
  ev.preventDefault();
  const text = document.getElementById("i_text").value;
  const { validEntries, errors, newCategories } = parseImportText(text);

  const resultEl = document.getElementById("importResult");
  resultEl.hidden = false;

  if (validEntries.length === 0) {
    resultEl.textContent = errors.length
      ? `Nothing imported. ${errors.length} line(s) had problems:\n${errors.join("\n")}`
      : "Nothing to import — paste some lines first.";
    return;
  }

  expenses.push(...validEntries);
  if (newCategories.length > 0) categories.push(...newCategories);

  renderAll();
  resultEl.textContent = `Imported ${validEntries.length} entr${validEntries.length === 1 ? "y" : "ies"}.` +
    (newCategories.length ? ` Added ${newCategories.length} new categor${newCategories.length === 1 ? "y" : "ies"}: ${newCategories.join(", ")}.` : "") +
    (errors.length ? `\n${errors.length} line(s) skipped:\n${errors.join("\n")}` : "");

  await persistExpenses(`Bulk import ${validEntries.length} expense entries`);
  if (newCategories.length > 0) {
    await persistCategories("Add categories from bulk import");
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

document.getElementById("reviewBtn").addEventListener("click", openReviewSheet);
document.getElementById("closeReviewBtn").addEventListener("click", closeReviewSheet);
document.getElementById("reviewBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "reviewBackdrop") closeReviewSheet();
});

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
    renderBudgetInputs();
  }
  input.value = "";
});

document.getElementById("openImportBtn").addEventListener("click", openImportSheet);
document.getElementById("cancelImportBtn").addEventListener("click", closeImportSheet);
document.getElementById("importSheet").addEventListener("submit", handleImportSubmit);
document.getElementById("importBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "importBackdrop") closeImportSheet();
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
