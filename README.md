# Our Ledger

A tiny joint expense tracker for two phones. No backend, no signup beyond
GitHub itself — entries are committed straight to a private GitHub repo as
JSON, and the app (hosted on GitHub Pages) reads/writes them live through
the GitHub API.

## Why two repos

Free GitHub accounts can only run GitHub Pages on a **public** repo. But you
don't want your actual spending data sitting in a public file anyone can
read. So this uses two repos:

1. **App repo (public)** — just this code. No secrets in it, nothing
   sensitive — safe to be public. This is what GitHub Pages serves.
2. **Data repo (private)** — holds `data/expenses.json` and
   `data/categories.json`. Only reachable with your personal access token,
   so it stays private even though the app itself is public.

## 1. Create the data repo (private)

1. On GitHub, click **New repository**.
2. Name it something like `ledger-data`.
3. Set visibility to **Private**.
4. Add a README so it's not empty, then **Create repository**. You don't
   need to add anything else — the app will create `data/expenses.json` and
   `data/categories.json` the first time it connects.

## 2. Create a personal access token

This token only needs access to the **data repo**, and only to its contents.

1. Go to **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Give it a name like `ledger-app`.
3. Under **Repository access**, choose **Only select repositories** and pick
   `ledger-data`.
4. Under **Permissions → Repository permissions**, set **Contents** to
   **Read and write**. Leave everything else as No access.
5. Generate the token and copy it somewhere safe — you'll paste it into the
   app's Settings screen. GitHub only shows it once.

You and Kenzie can either share one token (simplest, since you're both
trusted on the same data) or each generate your own fine-grained token
scoped the same way. Either works — the app just needs *a* valid token with
contents read/write on the data repo.

## 3. Create the app repo (public) and push this code

1. Create a new **public** repo, e.g. `our-ledger`.
2. Push all the files in this folder (`index.html`, `style.css`, `app.js`,
   `manifest.json`, `sw.js`, `icons/`) to it.
3. In the repo, go to **Settings → Pages**. Under **Build and deployment**,
   set **Source** to **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Wait a minute or two, then visit the URL GitHub gives you
   (`https://<you>.github.io/our-ledger/`).

## 4. Connect the app to your data repo

1. Open the deployed site. Since it's unconfigured, the Settings sheet opens
   automatically.
2. Fill in:
   - **Data repo owner** — your GitHub username
   - **Data repo name** — `ledger-data`
   - **Branch** — `main`
   - **Personal access token** — the one from step 2
   - **This device defaults to** — Cayden, Kenzie, or Joint (just saves you
     a tap when logging on this phone)
3. Tap **Save & Connect**. The app will create `expenses.json` and
   `categories.json` in your data repo automatically.
4. Do the same on Kenzie's phone, pointed at the same data repo. You'll both
   be reading and writing the same files.

## 5. Add it to your home screen

**iPhone (Safari):** open the site → Share icon → **Add to Home Screen**.

**Android (Chrome):** open the site → ⋮ menu → **Add to Home screen** (or
you'll see an automatic install prompt/banner).

It'll open full-screen, no browser bar, like a normal app.

## How it works day to day

- Tap the **+** button to log an expense: when, where, what, who (Joint /
  Kenzie / Cayden), why (category), and the amount.
- The big number up top is your total for the month you're viewing. Use the
  **‹ ›** arrows to flip between months.
- The pills under it show the Joint / Kenzie / Cayden split.
- The breakdown below that is by category, biggest first — that's your
  "where is the money actually going" view.
- Tap any entry in the list to edit or delete it.
- The gear icon opens Settings, where you can also add or remove categories.

## A couple of honest limitations

- **This is not bank-grade security.** The token lives in each phone's
  browser storage. That's fine for two people tracking household spending in
  a private repo, but don't reuse a token that has access to anything more
  sensitive.
- **No real-time push.** If you both add an expense in the same minute,
  whoever saves second will briefly hit a "someone else just saved" conflict
  — the app automatically refetches and retries, so it resolves itself, but
  you might see a flash of "Saving…" twice.
- **Every entry is a GitHub commit.** That's a feature, not a bug — your
  data repo's commit history is literally an audit log of every expense ever
  added, edited, or deleted, with timestamps, for free.
