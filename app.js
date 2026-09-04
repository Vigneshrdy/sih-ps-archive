const state = {
  problems: [],
  total: 0,
  page: 1,
  hasMore: false,
  accessToken: "",
  email: "",
  search: "",
  theme: "",
  org: "",
  category: "",
  from: "",
  to: "",
  quick: "",
  individualReview: "",
  teamVote: "",
  team: null,
  view: "list",
  cameFromList: false,
  currentProblem: null,
  listLoaded: false,
  filtersLoaded: false,
  reviewCache: {},
  compare: new Set(JSON.parse(localStorage.getItem("sih-compare") || "[]")),
  browseScope: "all",
  boardCollapsed: JSON.parse(localStorage.getItem("sih-board-collapsed") || "{}"),
  starred: new Set(JSON.parse(localStorage.getItem("sih-starred") || "[]")),
};

const $ = (selector) => document.querySelector(selector);
const list = $("#problem-list");
const filters = $("#filters");
const filterNames = { search: "Search", theme: "Theme", org: "Organization", individualReview: "Your review", teamVote: "Your team vote", category: "Category", from: "From PS", to: "To PS", quick: "Quick pick" };
const DETAIL_PREFIX = "/problem-statements/";
let refreshRequest;
let searchTimer;
let toastTimer;
let pendingRoute = "";
let commentsObserver;
const DEFAULT_TITLE = "SIH 2026 Selection Desk";
const READING_STATES = { "to-read": "To read", read: "Read" };
const DECISION_STATES = { keep: "Keep", accept: "Accept", reject: "Reject" };
const VOTE_STATES = { yes: "Yes", maybe: "Maybe", no: "No" };

function setDocumentTitle(title = "") {
  document.title = title ? `${title} • ${DEFAULT_TITLE}` : DEFAULT_TITLE;
}

function currentDetailId() {
  const path = decodeURIComponent(location.pathname);
  return path.startsWith(DETAIL_PREFIX) ? path.slice(DETAIL_PREFIX.length).replace(/\/$/, "") : "";
}

function emptyReview() {
  return { reading: "", decision: "", privateNote: "", vote: "", votes: { yes: 0, maybe: 0, no: 0, total: 0 } };
}

function normalizeReviewPayload(payload = {}) {
  return {
    ...emptyReview(),
    ...(payload.review || payload),
    vote: payload.vote || payload.review?.vote || "",
    votes: { ...emptyReview().votes, ...(payload.votes || payload.review?.votes || {}) },
  };
}

function reviewState(id) {
  return state.reviewCache[id] || emptyReview();
}

function compareIds() {
  return [...state.compare];
}

function persistCompare() {
  localStorage.setItem("sih-compare", JSON.stringify(compareIds()));
}

function persistBoardCollapsed() {
  localStorage.setItem("sih-board-collapsed", JSON.stringify(state.boardCollapsed));
}

function reviewBadge(tone, label) {
  return `<span class="status-badge ${tone}">${label}</span>`;
}

function reviewBadges(id) {
  const review = reviewState(id);
  return [
    review.reading ? reviewBadge(`reading-${review.reading}`, READING_STATES[review.reading]) : "",
    review.decision ? reviewBadge(`decision-${review.decision}`, DECISION_STATES[review.decision]) : "",
    review.vote ? reviewBadge(`vote-${review.vote}`, `Vote: ${VOTE_STATES[review.vote]}`) : "",
  ].filter(Boolean).join("");
}

function decisionFilter(problem) {
  return state.quick !== "hide-rejected" || reviewState(problem.ps_number).decision !== "reject";
}

function reviewFilter(problem) {
  const review = reviewState(problem.ps_number);
  if (state.individualReview) {
    const matches = state.individualReview === "to-read" || state.individualReview === "read"
      ? review.reading === state.individualReview
      : review.decision === state.individualReview;
    if (!matches) return false;
  }
  if (state.teamVote && review.vote !== state.teamVote) return false;
  return true;
}

// Reviews are per-account decoration on public text, on the detail path as much as on
// the list path -- this is the sibling of loadReviewsForProblems() below and needs the
// same guard. Without it, opening a statement without an account ran into api()'s
// account offer and showDetail()'s catch replaced the statement with an error: clicking
// a problem statement asked for a login. A failed read is not fatal either, because
// showDetail() has already put the official text on screen.
async function loadReview(id) {
  if (!state.accessToken) return emptyReview();
  try {
    const review = normalizeReviewPayload(await api(`/api/reviews?ps=${encodeURIComponent(id)}`));
    state.reviewCache[id] = review;
    return review;
  } catch {
    return emptyReview();
  }
}

// The one review call that does ask for a login, because it is the one the visitor
// pressed a button for. Throwing keeps callers like setDecision() from rendering a save
// that never happened.
async function saveReview(id, payload) {
  const result = await api(`/api/reviews?ps=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const review = normalizeReviewPayload(result);
  state.reviewCache[id] = review;
  return review;
}

async function loadReviewsForProblems(ids) {
  // Reviews are per-account. An anonymous visitor has none, and asking for them would
  // turn a free browse into a 401 and a pointless refresh attempt.
  if (!state.accessToken) return;
  const missing = ids.filter((id) => !(id in state.reviewCache));
  if (!missing.length) return;
  try {
    const result = await api(`/api/reviews?ids=${missing.map(encodeURIComponent).join(",")}`);
    for (const id of missing) state.reviewCache[id] = normalizeReviewPayload(result.reviews[id] || {});
  } catch {
    // Badges stay blank. A dead session must not blank the statement list with it.
  }
}

async function problemForCompare(id) {
  await loadDataset();
  return dataset.byId.get(id) || null;
}

function applyMetadata(metadata) {
  populateSelect("#theme", metadata.themes);
  populateSelect("#org", metadata.orgs);
  $("#total-count").textContent = metadata.stats.total;
  $("#theme-count").textContent = metadata.stats.themes;
  $("#org-count").textContent = metadata.stats.orgs;
  // The PS-range inputs used to carry a hardcoded ceiling that drifted out of step with
  // the data, so take it from the dataset itself.
  for (const input of [$("#ps-from"), $("#ps-to")]) input.max = metadata.stats.total;
  $("#ps-to").placeholder = metadata.stats.total;
  state.filtersLoaded = true;
  syncControls();
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

// escapeHtml makes a URL safe to sit inside an attribute but does nothing about its
// scheme: `javascript:...` would survive it intact.
function safeUrl(value) {
  try {
    const url = new URL(String(value), location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function toast(message, kind = "ok") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

function busy(form, isBusy, label) {
  const button = form.querySelector("button[type=submit]");
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = isBusy;
  button.textContent = isBusy ? label : button.dataset.label;
}

function populateSelect(selector, values) {
  const select = $(selector);
  select.length = 1;
  values.forEach((value) => select.add(new Option(value, value)));
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  ["search", "theme", "org", "individualReview", "teamVote", "category", "from", "to", "quick"].forEach((key) => {
    if (params.has(key)) state[key] = params.get(key);
  });
}

function syncUrl() {
  if (state.view !== "list") return;
  const params = new URLSearchParams();
  ["search", "theme", "org", "individualReview", "teamVote", "category", "from", "to", "quick"].forEach((key) => {
    if (state[key]) params.set(key, state[key]);
  });
  history.replaceState(history.state, "", `/${params.size ? `?${params}` : ""}`);
}

function syncControls() {
  $("#search").value = state.search;
  ["theme", "org"].forEach((key) => $(`#${key}`).value = state[key]);
  $("#individual-review").value = state.individualReview;
  $("#team-vote").value = state.teamVote;
  $("#ps-from").value = state.from;
  $("#ps-to").value = state.to;
  document.querySelectorAll("#category-filter button").forEach((button) => button.classList.toggle("active", button.dataset.value === state.category));
  document.querySelectorAll("[data-quick]").forEach((button) => button.classList.toggle("active", button.dataset.quick === state.quick));
}

// The access token used to live only in memory, so every reload had to round-trip
// /api/session/refresh (Supabase + two DB writes) before anything could render --
// which is what made the boot screen and a login-screen flash visible on refresh.
// Persisting it means a reload restores the signed-in view immediately.
// ponytail: localStorage is readable by any script on this origin, so this trades
// XSS resistance for the reload experience. The strict CSP (script-src 'self', no
// inline scripts) is what keeps that trade acceptable; the refresh token itself
// stays in an HttpOnly cookie.
const SESSION_KEY = "sih-session:v1";

function saveSession(result) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      accessToken: result.accessToken,
      email: result.email || "",
      team: result.team || null,
      expiresAt: Date.now() + (Number(result.expiresIn) || 3600) * 1000,
    }));
  } catch {}
}

function readSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return saved?.accessToken ? saved : null;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}

async function refreshAccessToken() {
  if (!refreshRequest) {
    refreshRequest = fetch("/api/session/refresh", { method: "POST", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 401) clearSession();
          const failure = new Error(response.status === 401 ? "Session expired" : `Could not restore your session (${response.status})`);
          failure.status = response.status;
          throw failure;
        }
        const result = await response.json();
        state.accessToken = result.accessToken;
        state.email = result.email || "";
        state.team = result.team || null;
        saveSession(result);
        return result.accessToken;
      })
      .finally(() => { refreshRequest = null; });
  }
  return refreshRequest;
}

const SIGN_IN_REQUIRED = "Sign in to use private notes, teams and votes.";

async function api(path, options = {}, retry = true) {
  // Everything still behind api() is per-account: reviews, teams, comments. The
  // statements themselves are public and fetched without a token, so reaching here
  // with no session means an anonymous visitor pressed an account action -- offer the
  // account instead of spending a 401 and a refresh attempt to find that out.
  if (!state.accessToken) {
    openAuthDialog(SIGN_IN_REQUIRED);
    throw new Error(SIGN_IN_REQUIRED);
  }
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${state.accessToken}`);
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (response.status === 401 && retry) {
    try {
      await refreshAccessToken();
    } catch (error) {
      // Same rule as boot: only a 401 from the refresh means the session is really gone.
      // The app stays mounted -- browsing never needed the session -- so this drops the
      // account and asks for a login instead of tearing the page down.
      if (error.status === 401) {
        signOutLocal();
        openAuthDialog("Your session expired. Log in again.");
      }
      throw error;
    }
    return api(path, options, false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}

// The 226 official statements come from one public request and are then filtered,
// paginated and opened entirely in the browser, so browsing costs no further round
// trips. Plain fetch, not api(): the endpoint takes no token, and going through api()
// would send an anonymous visitor down the token-refresh path on a cold load.
const dataset = { rows: [], byId: new Map() };
let datasetRequest;

async function loadDataset() {
  if (dataset.rows.length) return dataset.rows;
  datasetRequest ||= fetch("/api/problems")
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load the problem statements (${response.status})`);
      return response.json();
    })
    .then((result) => {
      const rows = result.items || [];
      for (const row of rows) {
        row.blob = [row.ps_number, row.title, row.org, row.department, row.category, row.theme, row.description, row.expected_solution].join(" ").toLowerCase();
        dataset.byId.set(row.ps_number, row);
      }
      dataset.rows = rows;
      return rows;
    })
    .finally(() => { datasetRequest = null; });
  return datasetRequest;
}

function matchesFilters(problem) {
  if (state.theme && problem.theme !== state.theme) return false;
  if (state.org && problem.org !== state.org) return false;
  if (state.category && problem.category !== state.category) return false;
  const from = Number.parseInt(state.from, 10);
  const to = Number.parseInt(state.to, 10);
  if (from && problem.sno < from) return false;
  if (to && problem.sno > to) return false;
  if (state.quick === "starred" && !state.starred.has(problem.ps_number)) return false;
  if (state.quick === "dataset" && !problem.dataset_link) return false;
  // Every whitespace-separated term must appear somewhere in the statement, which
  // matches how the old websearch_to_tsquery behaved for ordinary queries.
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => problem.blob.includes(term));
}

async function loadProblems({ append = false } = {}) {
  const page = append ? state.page + 1 : 1;
  $("#load-more").disabled = true;
  try {
    const rows = await loadDataset();
    const matched = rows.filter(matchesFilters);
    const pageSize = 12;
    const visible = matched.slice(0, page * pageSize);
    state.page = page;
    state.hasMore = matched.length > visible.length;
    state.problems = visible.filter((problem) => decisionFilter(problem) && reviewFilter(problem));
    state.total = state.quick === "hide-rejected" ? state.problems.length : matched.length;
    state.listLoaded = true;
    // Render the list right away; review badges and the local decision/review
    // filters apply once the reviews request lands.
    render();
    await loadReviewsForProblems(visible.map((item) => item.ps_number));
    state.problems = visible.filter((problem) => decisionFilter(problem) && reviewFilter(problem));
    render();
  } catch (error) {
    showListError(error.message);
  } finally {
    $("#load-more").disabled = false;
  }
}

async function loadMetadata() {
  if (state.filtersLoaded) return;
  const rows = await loadDataset();
  const unique = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort();
  const themes = unique("theme");
  const orgs = unique("org");
  applyMetadata({ themes, orgs, stats: { total: rows.length, themes: themes.length, orgs: orgs.length } });
}

async function loadMetadataNonFatal() {
  try {
    await loadMetadata();
  } catch (error) {
    toast(`Filters are unavailable right now: ${error.message}`, "error");
  }
}

function cardTemplate(problem) {
  const starred = state.starred.has(problem.ps_number);
  const id = escapeHtml(problem.ps_number);
  const statuses = reviewBadges(problem.ps_number);
  const inCompare = state.compare.has(problem.ps_number);
  return `<article class="problem-card" data-open="${id}" tabindex="0" role="link" aria-label="Open ${id} in full">
    <div><span class="ps-id">${id}</span><span class="ps-category">${escapeHtml(problem.category)}</span></div>
    <div class="card-main">
      <h2>${escapeHtml(problem.title)}</h2>
      <p class="card-org">${escapeHtml(problem.org)} · ${escapeHtml(problem.theme)}</p>
      ${statuses ? `<div class="card-statuses">${statuses}</div>` : ""}
      <p class="card-summary">${escapeHtml(problem.summary)}</p>
      <span class="card-more">Read full statement →</span>
    </div>
    <div class="card-facts">
      <button class="text-button" type="button" data-compare="${id}">${inCompare ? "Remove compare" : "Compare"}</button>
    </div>
    <button class="icon-button ${starred ? "starred" : ""}" type="button" data-star="${id}" aria-label="${starred ? "Remove star from" : "Star"} ${id}" title="${starred ? "Remove from shortlist" : "Add to shortlist"}">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"></path></svg>
    </button>
  </article>`;
}

function activeFilterEntries() {
  return ["search", "theme", "org", "individualReview", "teamVote", "category", "from", "to", "quick"]
    .filter((key) => state[key])
    .map((key) => [key,
      key === "from" ? `From ${state[key]}`
        : key === "to" ? `To ${state[key]}`
          : key === "dataset" ? "Has dataset"
            : key === "hide-rejected" ? "Hide rejected"
              : key === "individualReview" ? `Review: ${READING_STATES[state[key]] || DECISION_STATES[state[key]]}`
                : key === "teamVote" ? `Team vote: ${VOTE_STATES[state[key]]}`
                  : state[key][0].toUpperCase() + state[key].slice(1)]);
}

function reviewSummaryCounts() {
  return state.problems.reduce((counts, problem) => {
    const review = reviewState(problem.ps_number);
    if (review.reading === "to-read") counts.toRead += 1;
    if (review.reading === "read") counts.read += 1;
    if (review.decision === "keep") counts.keep += 1;
    if (review.decision === "accept") counts.accept += 1;
    if (review.decision === "reject") counts.reject += 1;
    return counts;
  }, { toRead: 0, read: 0, keep: 0, accept: 0, reject: 0 });
}

function renderReviewSummary() {
  const counts = reviewSummaryCounts();
  const cards = [
    [counts.accept, "Accepted"],
    [counts.keep, "Keep"],
    [counts.reject, "Rejected"],
    [counts.toRead, "To read"],
    [counts.read, "Read"],
  ].filter(([count]) => count > 0);
  $("#review-summary").innerHTML = cards.map(([count, label]) => `<div class="summary-card"><strong>${count}</strong><span>${label}</span></div>`).join("");
}

function renderBoardSection(title, items) {
  if (!items.length) return "";
  const collapsed = Boolean(state.boardCollapsed[title]);
  return `<section class="board-section"><div class="board-head"><h3>${escapeHtml(title)}</h3><button class="board-toggle" type="button" data-toggle-board="${escapeHtml(title)}">${collapsed ? "Expand" : "Collapse"}</button></div><div class="board-items" ${collapsed ? "hidden" : ""}>${items.map((problem) => `<div class="board-item"><div class="board-copy"><strong>${escapeHtml(problem.ps_number)} · ${escapeHtml(problem.title)}</strong><p>${escapeHtml(problem.org)} · ${escapeHtml(problem.theme)}</p></div><div class="board-item-actions"><button class="text-button" type="button" data-open="${escapeHtml(problem.ps_number)}">Open</button><button class="text-button" type="button" data-board-decision="keep" data-ps="${escapeHtml(problem.ps_number)}">Keep</button><button class="text-button" type="button" data-board-decision="accept" data-ps="${escapeHtml(problem.ps_number)}">Accept</button><button class="text-button" type="button" data-board-decision="reject" data-ps="${escapeHtml(problem.ps_number)}">Reject</button></div></div>`).join("")}</div></section>`;
}

function renderReviewBoard() {
  const groups = {
    Accepted: state.problems.filter((problem) => reviewState(problem.ps_number).decision === "accept"),
    Keep: state.problems.filter((problem) => reviewState(problem.ps_number).decision === "keep"),
    Rejected: state.problems.filter((problem) => reviewState(problem.ps_number).decision === "reject"),
    "To Read": state.problems.filter((problem) => reviewState(problem.ps_number).reading === "to-read"),
  };
  $("#review-board").innerHTML = Object.entries(groups).map(([title, items]) => renderBoardSection(title, items)).join("");
}

async function setDecision(id, decision) {
  await saveReview(id, { ...reviewState(id), decision });
  if (state.currentProblem?.ps_number === id) renderCurrentProblem();
  if (state.quick === "hide-rejected" && decision === "reject") {
    state.problems = state.problems.filter((problem) => problem.ps_number !== id);
    state.total = state.problems.length;
  }
  render();
}

function toggleBoardSection(title) {
  state.boardCollapsed[title] = !state.boardCollapsed[title];
  persistBoardCollapsed();
  renderReviewBoard();
}

function exportBoard() {
  const groups = {
    Accepted: state.problems.filter((problem) => reviewState(problem.ps_number).decision === "accept"),
    Keep: state.problems.filter((problem) => reviewState(problem.ps_number).decision === "keep"),
    Rejected: state.problems.filter((problem) => reviewState(problem.ps_number).decision === "reject"),
    "To Read": state.problems.filter((problem) => reviewState(problem.ps_number).reading === "to-read"),
  };
  const total = Object.values(groups).reduce((sum, items) => sum + items.length, 0);
  if (!total) return toast("Nothing to export yet. Mark some problem statements first.", "error");
  const body = ["# SIH Review Board", ""]
    .concat(Object.entries(groups).flatMap(([title, items]) => items.length ? [`## ${title}`, ...items.map((problem) => `- ${problem.ps_number} - ${problem.title} (${problem.org})`), ""] : []))
    .join("\n");
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "sih-review-board.md";
  link.click();
  URL.revokeObjectURL(url);
}

function render() {
  list.innerHTML = state.problems.map(cardTemplate).join("");
  list.hidden = state.problems.length === 0;
  $("#empty-state").hidden = state.problems.length !== 0;
  $("#result-count").textContent = state.total;
  $("#active-summary").textContent = `· showing ${state.problems.length}`;
  $("#load-more").hidden = !state.hasMore;
  renderFilterState();
}

// Everything that reflects the filters rather than the result rows. Called on its own
// while the list is still loading, so it cannot touch the cards.
function renderFilterState() {
  const entries = activeFilterEntries();
  $("#active-filters").innerHTML = entries.map(([key, label]) => `<button class="active-filter" type="button" data-remove-filter="${key}" title="Remove ${filterNames[key]}">${escapeHtml(label)}</button>`).join("");
  const badge = $("#filter-badge");
  badge.textContent = entries.length;
  // The count is only worth pixels in the navbar when it is not zero.
  badge.hidden = entries.length === 0;
  $("#compare-count").textContent = state.compare.size;
  $("#open-compare").hidden = state.compare.size === 0;
  renderReviewSummary();
  renderReviewBoard();
  syncControls();
  syncUrl();
}

function showListLoading(message = "Loading statements…") {
  renderFilterState();
  list.hidden = false;
  $("#empty-state").hidden = true;
  $("#load-more").hidden = true;
  list.innerHTML = `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
}

function showListError(message) {
  list.hidden = false;
  list.innerHTML = `<div class="empty-state"><h2>Could not load statements</h2><p>${escapeHtml(message)}</p></div>`;
}

function listSection(title, items, open = false) {
  if (!items?.length) return "";
  return collapseSection(title, `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`, open);
}

// pre-wrap keeps the source paragraphs, line breaks and lettered lists intact
// without turning the text into markup.
function proseSection(title, body, open = false) {
  return body ? collapseSection(title, `<p class="detail-prose">${escapeHtml(body)}</p>`, open) : "";
}

// The detail page shows the statement itself and folds everything else behind
// expandable bars, so a first-time reader is not staring at 15 sections.
function collapseSection(title, inner, open = false) {
  return `<details class="detail-section detail-collapse"${open ? " open" : ""}><summary><h3>${escapeHtml(title)}</h3><span class="collapse-hint" aria-hidden="true"></span></summary><div class="collapse-body">${inner}</div></details>`;
}

function problemToMarkdown(problem) {
  const parts = [
    `# ${problem.ps_number} — ${problem.title}`, "",
    `**Organization:** ${problem.org}  `,
    `**Department:** ${problem.department || "N/A"}  `,
    `**Category:** ${problem.category} · **Theme:** ${problem.theme}`, "",
    problem.description ? `## Problem Statement\n\n${problem.description}` : "",
    problem.expected_solution ? `## Expected Solution\n\n${problem.expected_solution}` : "",
    problem.dataset ? `## Dataset\n\n${problem.dataset}` : "",
  ];
  return parts.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function aiPrompt(problem) {
  const md = problemToMarkdown(problem);
  // URL length caps: keep the prompt well under the ~8k most chat UIs accept.
  const body = md.length > 4000 ? `${md.slice(0, 4000)}\n\n…(truncated — copy the full statement with "Copy MD")` : md;
  return `We are picking a problem statement for Smart India Hackathon. Analyze this problem statement for feasibility in 36 hours, competition risk, and how a strong team should approach it:\n\n${body}`;
}

const AI_TARGETS = {
  chatgpt: (prompt) => `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`,
  claude: (prompt) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`,
  perplexity: (prompt) => `https://www.perplexity.ai/search?q=${encodeURIComponent(prompt)}`,
  gemini: () => "https://gemini.google.com/app",
};

function detailTemplate(problem) {
  const review = reviewState(problem.ps_number);
  return `<p class="detail-eyebrow">${escapeHtml(problem.org)}</p>
    <h1 id="detail-title">${escapeHtml(problem.title)}</h1>
    <div class="detail-tags"><span class="detail-tag">${escapeHtml(problem.ps_number)}</span><span class="detail-tag">${escapeHtml(problem.category)}</span><span class="detail-tag">${escapeHtml(problem.theme)}</span></div>
    <div class="detail-grid"><div>
      ${proseSection("Official description", problem.description, true)}
      ${proseSection("Expected solution", problem.expected_solution, !problem.description)}
      ${proseSection("Dataset", problem.dataset)}
    </div><aside>
      <section class="detail-section review-panel"><h3>Your review</h3>
        ${state.accessToken ? "" : '<p class="gate-status">Reading needs no account. Log in to save a review, a private note or a team vote.</p>'}
        <div class="review-group"><span>Reading</span><div class="review-actions">${Object.entries(READING_STATES).map(([value, label]) => `<button class="review-button ${review.reading === value ? "active" : ""}" type="button" data-set-reading="${value}">${label}</button>`).join("")}<button class="review-button clear" type="button" data-clear-reading>Clear</button></div></div>
        <div class="review-group"><span>Decision</span><div class="review-actions">${Object.entries(DECISION_STATES).map(([value, label]) => `<button class="review-button ${review.decision === value ? "active" : ""}" type="button" data-set-decision="${value}">${label}</button>`).join("")}<button class="review-button clear" type="button" data-clear-decision>Clear</button></div></div>
        ${state.team ? `<div class="review-group"><span>Team vote</span><div class="review-actions">${Object.entries(VOTE_STATES).map(([value, label]) => `<button class="review-button ${review.vote === value ? "active" : ""}" type="button" data-set-vote="${value}">${label}</button>`).join("")}<button class="review-button clear" type="button" data-clear-vote>Clear</button></div><div class="card-statuses"><span class="status-badge vote-yes">Yes ${review.votes.yes}</span><span class="status-badge vote-maybe">Maybe ${review.votes.maybe}</span><span class="status-badge vote-no">No ${review.votes.no}</span></div></div>` : ""}
        <form class="private-note-form" id="private-note-form"><label><span class="filter-label">Private note</span><textarea id="private-note-body" maxlength="4000" placeholder="Write your own note for this problem statement…">${escapeHtml(review.privateNote || "")}</textarea></label><div class="private-note-row"><span class="gate-status" id="private-note-status"></span><div class="private-note-actions"><button class="text-button" type="button" id="private-note-clear">Clear note</button><button class="primary-button" type="submit">Save note</button></div></div></form>
        <div class="review-group"><span>Compare</span><div class="review-actions"><button class="review-button ${state.compare.has(problem.ps_number) ? "active" : ""}" type="button" data-compare="${escapeHtml(problem.ps_number)}">${state.compare.has(problem.ps_number) ? "Selected for compare" : "Add to compare"}</button></div></div>
      </section>
      <div class="mini-stat"><span>Organization</span><strong>${escapeHtml(problem.org || "—")}</strong></div>
      <div class="mini-stat"><span>Department</span><strong>${escapeHtml(problem.department || "—")}</strong></div>
      <div class="mini-stat"><span>Category</span><strong>${escapeHtml(problem.category || "—")}</strong></div>
      <div class="mini-stat"><span>Theme</span><strong>${escapeHtml(problem.theme || "—")}</strong></div>
      ${problem.dataset_link ? `<div class="mini-stat"><span>Dataset</span><strong><a href="${escapeHtml(problem.dataset_link)}" rel="noreferrer noopener">Open dataset ↗</a></strong></div>` : ""}

      <section class="detail-section" id="comments-section"><h3>Team notes</h3>${state.team ? '<div id="comment-list"><p>Loading team notes…</p></div><form class="comment-form" id="comment-form"><textarea id="comment-body" maxlength="2000" required placeholder="Add a team note…"></textarea><div class="comment-row"><span class="gate-status" id="comment-status"></span><button class="primary-button" type="submit">Add team note</button></div></form>' : '<p>Create or join a team to read and leave team notes.</p>'}</section>
    </aside></div>`;
}

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(history.state, "", path);
  else history.pushState({}, "", path);
  route();
}

function route() {
  const path = decodeURIComponent(location.pathname);
  const id = path.startsWith(DETAIL_PREFIX) ? path.slice(DETAIL_PREFIX.length).replace(/\/$/, "") : "";
  if (id) showDetail(id);
  else showList();
}

function showList() {
  state.view = "list";
  state.currentProblem = null;
  setDocumentTitle("");
  $("#list-view").hidden = false;
  $("#detail-view").hidden = true;
  if (!localStorage.getItem("sih-tour-done") && state.listLoaded) setTimeout(startTour, 600);
  if (!state.listLoaded) {
    list.hidden = false;
    $("#empty-state").hidden = true;
    list.innerHTML = '<div class="empty-state"><p>Loading statements…</p></div>';
    loadMetadataNonFatal();
    loadProblems();
    return;
  }
  render();
}

function renderCurrentProblem() {
  if (!state.currentProblem) return;
  $("#detail-body").innerHTML = detailTemplate(state.currentProblem);
  $("#private-note-form")?.addEventListener("submit", submitPrivateNote);
  $("#private-note-clear")?.addEventListener("click", clearPrivateNote);
  if (state.team) {
    $("#comment-form").addEventListener("submit", (event) => submitComment(event, state.currentProblem.ps_number));
    watchCommentsLoad(state.currentProblem.ps_number);
  }
  syncDetailNav();
}

async function showDetail(id) {
  state.view = "detail";
  setDocumentTitle(id);
  $("#list-view").hidden = true;
  $("#detail-view").hidden = false;
  $("#detail-number").textContent = id;
  $("#detail-star").dataset.star = id;
  $("#detail-star").classList.toggle("starred", state.starred.has(id));
  $("#detail-body").innerHTML = '<div class="empty-state"><p>Loading the full problem statement…</p></div>';
  window.scrollTo({ top: 0, behavior: "auto" });
  if (!/^SIH\d{5}$/.test(id)) {
    $("#detail-body").innerHTML = '<div class="empty-state"><h2>Unknown statement</h2><p>That problem statement number does not exist.</p></div>';
    return;
  }
  try {
    await loadDataset();
    const problem = dataset.byId.get(id);
    if (state.view !== "detail" || $("#detail-star").dataset.star !== id) return;
    if (!problem) {
      $("#detail-body").innerHTML = '<div class="empty-state"><h2>Unknown statement</h2><p>That problem statement number does not exist.</p></div>';
      return;
    }
    state.currentProblem = problem;
    setDocumentTitle(problem.ps_number || id);
    renderCurrentProblem();
    await loadReview(id);
    if (state.currentProblem?.ps_number === id) renderCurrentProblem();
    if (state.listLoaded) render();
  } catch (error) {
    $("#detail-body").innerHTML = `<div class="empty-state"><h2>Could not open statement</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function toggleStar(id) {
  state.starred.has(id) ? state.starred.delete(id) : state.starred.add(id);
  localStorage.setItem("sih-starred", JSON.stringify([...state.starred]));
  if (state.view === "detail") {
    $("#detail-star").classList.toggle("starred", state.starred.has(id));
    return;
  }
  if (state.quick === "starred") loadProblems(); else render();
}

function toggleCompare(id) {
  if (state.compare.has(id)) state.compare.delete(id);
  else {
    if (state.compare.size >= 4) return toast("Compare supports up to 4 problem statements.", "error");
    state.compare.add(id);
  }
  persistCompare();
  if (state.view === "detail" && state.currentProblem?.ps_number === id) renderCurrentProblem();
  if (state.listLoaded) render();
}

// The statement sequence ← / → walks, optionally narrowed to one review state.
function browseSequence() {
  const all = state.problems;
  if (state.browseScope === "all" || state.browseScope === "starred") {
    return state.browseScope === "starred" ? all.filter((p) => state.starred.has(p.ps_number)) : all;
  }
  return all.filter((p) => reviewState(p.ps_number)[state.browseScope === "to-read" ? "reading" : "decision"] === state.browseScope);
}

function syncDetailNav() {
  if (state.view !== "detail") return;
  const sequence = browseSequence();
  const index = sequence.findIndex((p) => p.ps_number === state.currentProblem?.ps_number);
  $("#detail-scope").value = state.browseScope;
  $("#detail-prev").disabled = index <= 0;
  $("#detail-next").disabled = index === -1 || index >= sequence.length - 1;
}

function stepStatement(direction) {
  const sequence = browseSequence();
  const index = sequence.findIndex((p) => p.ps_number === state.currentProblem?.ps_number);
  const target = index === -1 ? (direction > 0 ? 0 : sequence.length - 1) : index + direction;
  if (target < 0 || target >= sequence.length) return;
  navigate(`/problem-statements/${encodeURIComponent(sequence[target].ps_number)}`);
}

async function openCompareDialog() {
  const ids = compareIds();
  if (ids.length < 2) return toast("Pick at least 2 problem statements to compare.", "error");
  $("#compare-content").innerHTML = "<p>Loading comparison…</p>";
  if (!$("#compare-dialog").open) $("#compare-dialog").showModal();
  try {
    const problems = await Promise.all(ids.map(problemForCompare));
    $("#compare-content").innerHTML = `<div class="compare-grid">${problems.map((problem) => {
      const review = reviewState(problem.ps_number);
      const statuses = reviewBadges(problem.ps_number);
      return `<article class="compare-card"><span class="detail-tag">${escapeHtml(problem.ps_number)}</span><span class="detail-tag">${escapeHtml(problem.category)}</span><span class="detail-tag">${escapeHtml(problem.theme)}</span><h3>${escapeHtml(problem.title)}</h3><p>${escapeHtml(problem.org)}</p>${statuses ? `<div class="card-statuses">${statuses}</div>` : ""}<p>${escapeHtml(problem.summary || problem.description || "")}</p>${review.privateNote ? `<section><strong>Your note</strong><p>${escapeHtml(review.privateNote)}</p></section>` : ""}<div class="board-item-actions"><button class="text-button" type="button" data-open="${escapeHtml(problem.ps_number)}">Open</button><button class="text-button" type="button" data-compare="${escapeHtml(problem.ps_number)}">Remove compare</button></div></article>`;
    }).join("")}</div>`;
  } catch (error) {
    $("#compare-content").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

function clearFilters() {
  clearTimeout(searchTimer);
  Object.assign(state, { search: "", theme: "", org: "", individualReview: "", teamVote: "", category: "", from: "", to: "", quick: "" });
  closeMobileFilters();
  showListLoading("Clearing filters…");
  loadProblems();
}

function filterChanged() {
  showListLoading();
  loadProblems();
}

function bindEvents() {
  $("#theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("sih-theme", dark ? "dark" : "light");
    document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#10161f" : "#194fd1");
  });
  $("#help-button").addEventListener("click", startTour);
  $("#tour-skip").addEventListener("click", endTour);
  $("#tour-next").addEventListener("click", nextTourStep);
  $("#copy-md").addEventListener("click", async () => {
    if (!state.currentProblem) return;
    try {
      await navigator.clipboard.writeText(problemToMarkdown(state.currentProblem));
      toast("Statement copied as markdown.");
    } catch {
      toast("Could not access the clipboard.", "error");
    }
  });
  $("#ask-menu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-ask]");
    if (!button || !state.currentProblem) return;
    const target = AI_TARGETS[button.dataset.ask];
    const prompt = aiPrompt(state.currentProblem);
    if (button.dataset.ask === "gemini") {
      // Gemini's web UI has no prompt URL parameter — copy it and open a blank chat.
      navigator.clipboard.writeText(prompt).then(() => toast("Prompt copied — paste it into Gemini.")).catch(() => {});
    }
    window.open(target(prompt), "_blank", "noreferrer noopener");
    $("#ask-menu").removeAttribute("open");
  });
  $("#detail-prev").addEventListener("click", () => stepStatement(-1));
  $("#detail-next").addEventListener("click", () => stepStatement(1));
  $("#detail-scope").addEventListener("change", (event) => { state.browseScope = event.target.value; syncDetailNav(); });
  document.addEventListener("keydown", (event) => {
    if (state.view !== "detail" || event.target.matches("input, textarea, select")) return;
    if (event.key === "ArrowLeft") stepStatement(-1);
    if (event.key === "ArrowRight") stepStatement(1);
  });
  $("#search").addEventListener("input", (event) => {
    state.search = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      // Search lives in the navbar, so it is reachable from a statement page too.
      // Typing there means "take me back to the results".
      if (state.view !== "list") navigate("/");
      filterChanged();
    }, 300);
  });
  ["theme", "org"].forEach((key) => $(`#${key}`).addEventListener("change", (event) => { state[key] = event.target.value; filterChanged(); }));
  [["individual-review", "individualReview"], ["team-vote", "teamVote"]].forEach(([id, key]) => $(`#${id}`).addEventListener("change", (event) => { state[key] = event.target.value; filterChanged(); }));
  [["ps-from", "from"], ["ps-to", "to"]].forEach(([id, key]) => $(`#${id}`).addEventListener("change", (event) => { state[key] = event.target.value; filterChanged(); }));
  $("#category-filter").addEventListener("click", (event) => { const button = event.target.closest("button"); if (button) { state.category = button.dataset.value; filterChanged(); } });
  document.querySelector(".quick-picks").addEventListener("click", (event) => { const button = event.target.closest("button"); if (button) { state.quick = state.quick === button.dataset.quick ? "" : button.dataset.quick; filterChanged(); } });
  list.addEventListener("click", (event) => {
    const star = event.target.closest("[data-star]");
    if (star) return toggleStar(star.dataset.star);
    const compare = event.target.closest("[data-compare]");
    if (compare) return toggleCompare(compare.dataset.compare);
    const card = event.target.closest("[data-open]");
    if (card) openStatement(card.dataset.open);
  });
  list.addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-open]");
    if (card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openStatement(card.dataset.open); }
  });
  $("#review-board").addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-toggle-board]");
    if (toggle) return toggleBoardSection(toggle.dataset.toggleBoard);
    const open = event.target.closest("[data-open]");
    if (open) return openStatement(open.dataset.open);
    const move = event.target.closest("[data-board-decision]");
    if (move) {
      try {
        await setDecision(move.dataset.ps, move.dataset.boardDecision);
      } catch (error) {
        toast(error.message, "error");
      }
    }
  });
  $("#active-filters").addEventListener("click", (event) => { const button = event.target.closest("[data-remove-filter]"); if (button) { state[button.dataset.removeFilter] = ""; filterChanged(); } });
  $("#load-more").addEventListener("click", () => loadProblems({ append: true }));
  $("#clear-filters").addEventListener("click", clearFilters);
  $("#empty-clear").addEventListener("click", clearFilters);
  $("#detail-back").addEventListener("click", () => { if (state.cameFromList) history.back(); else navigate("/"); });
  $("#detail-star").addEventListener("click", (event) => toggleStar(event.currentTarget.dataset.star));
  $("#detail-view").addEventListener("click", async (event) => {
    if (!state.currentProblem) return;
    const id = state.currentProblem.ps_number;
    try {
      const reading = event.target.closest("[data-set-reading]");
      if (reading) {
        await saveReview(id, { ...reviewState(id), reading: reading.dataset.setReading });
        renderCurrentProblem();
        if (state.listLoaded) render();
        return;
      }
      const decision = event.target.closest("[data-set-decision]");
      if (decision) {
        await saveReview(id, { ...reviewState(id), decision: decision.dataset.setDecision });
        renderCurrentProblem();
        if (state.listLoaded) render();
        return;
      }
      const vote = event.target.closest("[data-set-vote]");
      if (vote) {
        await saveReview(id, { ...reviewState(id), vote: vote.dataset.setVote });
        renderCurrentProblem();
        if (state.listLoaded) render();
        return;
      }
      if (event.target.closest("[data-clear-reading]")) {
        await saveReview(id, { ...reviewState(id), reading: "" });
        renderCurrentProblem();
        if (state.listLoaded) render();
        return;
      }
      if (event.target.closest("[data-clear-decision]")) {
        await saveReview(id, { ...reviewState(id), decision: "" });
        renderCurrentProblem();
        if (state.listLoaded) render();
        return;
      }
      if (event.target.closest("[data-clear-vote]")) {
        await saveReview(id, { ...reviewState(id), vote: "" });
        renderCurrentProblem();
        if (state.listLoaded) render();
        return;
      }
      const compare = event.target.closest("[data-compare]");
      if (compare) toggleCompare(compare.dataset.compare);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#filter-button").addEventListener("click", () => {
    if (filters.classList.contains("open")) return closeMobileFilters();
    filters.classList.add("open");
    $("#filter-backdrop").hidden = false;
    $("#filter-button").setAttribute("aria-expanded", "true");
  });
  $("#open-compare").addEventListener("click", openCompareDialog);
  $("#export-board").addEventListener("click", exportBoard);
  $("#compare-dialog-close").addEventListener("click", () => $("#compare-dialog").close());
  $("#compare-content").addEventListener("click", (event) => {
    const open = event.target.closest("[data-open]");
    if (open) {
      $("#compare-dialog").close();
      return openStatement(open.dataset.open);
    }
    const compare = event.target.closest("[data-compare]");
    if (compare) {
      toggleCompare(compare.dataset.compare);
      return openCompareDialog().catch((error) => toast(error.message, "error"));
    }
  });
  $("#filter-close").addEventListener("click", closeMobileFilters);
  $("#filter-backdrop").addEventListener("click", closeMobileFilters);
  $("#join-group-button").addEventListener("click", () => {
    if (!state.accessToken) return openAuthDialog("Log in to create or join a team.");
    openTeamDialog(state.team ? "join" : "create");
  });
  $("#group-dialog-close").addEventListener("click", () => $("#group-dialog").close());
  $("#team-mode").addEventListener("click", (event) => { const button = event.target.closest("button"); if (button) setTeamMode(button.dataset.mode); });
  $("#team-create-form").addEventListener("submit", (event) => submitTeam(event, "create"));
  $("#team-join-form").addEventListener("submit", (event) => submitTeam(event, "join"));
  $("#team-leave").addEventListener("click", leaveTeam);
  $("#auth-mode").addEventListener("click", (event) => { const button = event.target.closest("button"); if (button) setAuthMode(button.dataset.mode); });
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#logout-button").addEventListener("click", logout);
  $("#auth-back").addEventListener("click", () => $("#access-gate").close());
  window.addEventListener("popstate", route);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && filters.classList.contains("open")) closeMobileFilters();
    if (event.key === "/" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { event.preventDefault(); $("#search").focus(); }
  });
}

function openStatement(id) {
  state.cameFromList = state.view === "list";
  navigate(`${DETAIL_PREFIX}${encodeURIComponent(id)}`);
}

function closeMobileFilters() {
  filters.classList.remove("open");
  $("#filter-backdrop").hidden = true;
  $("#filter-button").setAttribute("aria-expanded", "false");
}

async function startApp() {
  $("#boot-screen").hidden = true;
  $("#navbar").hidden = false;
  renderTeamBar();
  if (pendingRoute) {
    navigate(pendingRoute, { replace: true });
    pendingRoute = "";
  } else {
    await Promise.all([loadMetadataNonFatal(), loadProblems()]);
    route();
  }
}

// The whole team state reads off one navbar button now: what it says is what the next
// step is. Anonymous browsing is the default, so it sells the account rather than
// pretending the visitor has an empty team, and there is nothing to log out of.
function renderTeamBar() {
  const button = $("#join-group-button");
  $("#logout-button").hidden = !state.accessToken;
  if (!state.accessToken) {
    button.textContent = "Sign in";
    button.title = "Sign in to shortlist with a team, take private notes and vote";
    return;
  }
  if (!state.team) {
    button.textContent = "Create team";
    button.title = "Create or join a team of up to 6 to vote and share notes";
    return;
  }
  // A team name is unbounded user text and the button clips it, so the full value
  // stays reachable in the tooltip.
  button.textContent = `${state.team.name} · ${state.team.members}/${state.team.maxMembers}`;
  button.title = `${state.team.name} — ${state.team.members} of ${state.team.maxMembers} members · Team Lead ${state.team.leaderName}`;
}

function renderTeamPanel() {
  const inTeam = Boolean(state.team);
  $("#team-panel").hidden = !inTeam;
  $("#team-mode").hidden = inTeam;
  if (!inTeam) return;
  $("#team-create-form").hidden = true;
  $("#team-join-form").hidden = true;
  $("#team-panel-name").textContent = state.team.name;
  $("#team-panel-count").textContent = `${state.team.members} / ${state.team.maxMembers} Members`;
  $("#team-roster").innerHTML = Array.isArray(state.team.roster)
    ? state.team.roster.map((person) => `<li>${escapeHtml(person.name)}${person.isLead ? '<span class="lead-badge">Team Lead</span>' : ""}</li>`).join("")
    : "<li>Loading team roster…</li>";
  $("#team-full-note").hidden = !state.team.full;
}

async function loadFullTeam() {
  if (!state.team || Array.isArray(state.team.roster)) return;
  const result = await api("/api/team");
  state.team = result.team;
  renderTeamBar();
  renderTeamPanel();
}

function openTeamDialog(mode) {
  $("#team-status").textContent = "";
  $("#team-status").classList.remove("error");
  renderTeamPanel();
  if (!state.team) setTeamMode(mode);
  if (!$("#group-dialog").open) $("#group-dialog").showModal();
  if (state.team) loadFullTeam().catch((error) => {
    $("#team-status").textContent = error.message;
    $("#team-status").classList.add("error");
  });
}

function setTeamMode(mode) {
  document.querySelectorAll("#team-mode button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  $("#team-create-form").hidden = mode !== "create";
  $("#team-join-form").hidden = mode === "create";
}

async function submitTeam(event, action) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $("#team-status");
  const prefix = action === "create" ? "create" : "join";
  status.textContent = "";
  status.classList.remove("error");
  busy(form, true, action === "create" ? "Creating…" : "Joining…");
  try {
    const result = await api("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        teamName: $(`#${prefix}-team-name`).value,
        teamPassword: $(`#${prefix}-team-password`).value,
        displayName: $(action === "create" ? "#create-leader-name" : "#join-member-name").value,
      }),
    });
    state.team = result.team;
    renderTeamBar();
    renderTeamPanel();
    $(`#${prefix}-team-password`).value = "";
    toast(action === "create" ? "Team created successfully" : "You joined the team successfully");
    if (state.view === "detail") showDetail($("#detail-star").dataset.star);
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    busy(form, false);
  }
}

async function leaveTeam() {
  const button = $("#team-leave");
  button.disabled = true;
  try {
    await api("/api/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "leave" }) });
    state.team = null;
    renderTeamBar();
    renderTeamPanel();
    toast("You left the team");
    if (state.view === "detail") showDetail($("#detail-star").dataset.star);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function commentTemplate(comment) {
  return `<article class="comment"><span class="comment-meta"><strong>${escapeHtml(comment.display_name)}</strong> · ${new Date(comment.created_at).toLocaleString()}</span><p>${escapeHtml(comment.body)}</p></article>`;
}

async function loadComments(id) {
  try {
    const result = await api(`/api/comments?ps=${encodeURIComponent(id)}`);
    $("#comment-list").innerHTML = result.comments.length ? result.comments.map(commentTemplate).join("") : "<p>No comments yet. Start the discussion for your team.</p>";
  } catch (error) {
    $("#comment-list").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

async function submitPrivateNote(event) {
  event.preventDefault();
  if (!state.currentProblem) return;
  const form = event.currentTarget;
  const status = $("#private-note-status");
  status.textContent = "";
  status.classList.remove("error");
  busy(form, true, "Saving note…");
  try {
    await saveReview(state.currentProblem.ps_number, { ...reviewState(state.currentProblem.ps_number), privateNote: $("#private-note-body").value.trim() });
    renderCurrentProblem();
    if (state.listLoaded) render();
    toast("Private note saved");
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    busy(form, false);
  }
}

function clearPrivateNote() {
  if (!$("#private-note-body")) return;
  $("#private-note-body").value = "";
}

function watchCommentsLoad(id) {
  const section = $("#comments-section");
  if (!section || !state.team) return;
  commentsObserver?.disconnect();
  commentsObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    commentsObserver?.disconnect();
    commentsObserver = null;
    loadComments(id);
  }, { rootMargin: "240px 0px" });
  commentsObserver.observe(section);
}

async function submitComment(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $("#comment-status");
  status.textContent = "";
  status.classList.remove("error");
  busy(form, true, "Posting…");
  try {
    await api(`/api/comments?ps=${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: $("#comment-body").value }) });
    $("#comment-body").value = "";
    toast("Comment added");
    await loadComments(id);
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    busy(form, false);
  }
}

function setAuthMode(mode) {
  document.querySelectorAll("#auth-mode button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  const submit = $("#auth-submit");
  submit.dataset.mode = mode;
  submit.dataset.label = mode === "signup" ? "Create account" : "Log in";
  submit.textContent = submit.dataset.label;
  $("#auth-password").setAttribute("autocomplete", mode === "signup" ? "new-password" : "current-password");
  $("#gate-status").textContent = mode === "signup" ? "Passwords must be at least 8 characters." : "";
  $("#gate-status").classList.remove("error");
}

// Spotlight tour: a cutout highlights one element at a time with a small card
// beside it. Runs once for a new browser; the "?" button in the navbar restarts it.
// Every selector must resolve to a *visible* element, because the spotlight is
// positioned from a live rect -- so this points at the filter button rather than at
// the controls inside the closed drawer.
const TOUR_STEPS = [
  { selector: "#search", title: "Search everything", text: "Type a keyword, an organization, or a PS number like SIH26011. Press / from anywhere to jump here." },
  { selector: "#filter-button", title: "Narrow it down", text: "Filters open here: theme, organization, Software or Hardware, PS number range, plus your own review status and your team's votes." },
  { selector: "#problem-list .problem-card", title: "Open a statement", text: "Click anywhere on a card to read the full problem statement. The star shortlists it; Compare queues up to 4 side by side." },
  { selector: "#export-board", title: "Your review board", text: "As you mark statements Keep / Accept / Reject, they collect on a board you can export as markdown." },
  { selector: "#join-group-button", title: "Team up", text: "Create or join a team of up to 6 to vote on statements and share team notes." },
];

let tourIndex = 0;
let tourTarget = null;

// Reposition on scroll/resize so the spotlight tracks the element it highlights.
function trackTourStep() {
  if (tourTarget) positionTourStep(tourTarget);
}

function startTour() {
  if (state.view !== "list" || !state.listLoaded || !$("#problem-list .problem-card")) return;
  tourIndex = 0;
  $("#tour-backdrop").hidden = false;
  window.addEventListener("scroll", trackTourStep, { passive: true });
  window.addEventListener("resize", trackTourStep);
  showTourStep();
}

function showTourStep() {
  const step = TOUR_STEPS[tourIndex];
  tourTarget = document.querySelector(step.selector);
  if (!tourTarget) return endTour();
  tourTarget.scrollIntoView({ block: "center" });
  positionTourStep(tourTarget);
  $("#tour-step-label").textContent = `Step ${tourIndex + 1} of ${TOUR_STEPS.length}`;
  $("#tour-title").textContent = step.title;
  $("#tour-text").textContent = step.text;
  $("#tour-next").textContent = tourIndex === TOUR_STEPS.length - 1 ? "Done" : "Next";
}

// All positioning derives from the live DOM rect of the target element.
function positionTourStep(target) {
  const rect = target.getBoundingClientRect();
  const spotlight = $("#tour-spotlight");
  spotlight.style.left = `${rect.left - 6}px`;
  spotlight.style.top = `${rect.top - 6}px`;
  spotlight.style.width = `${rect.width + 12}px`;
  spotlight.style.height = `${rect.height + 12}px`;
  const card = $("#tour-card");
  const cardHeight = card.offsetHeight || 200;
  card.style.left = `${Math.min(Math.max(16, rect.left), window.innerWidth - 336)}px`;
  // Prefer below the target; flip above it when that would run off the viewport.
  card.style.top = rect.bottom + 18 + cardHeight > window.innerHeight
    ? `${Math.max(16, rect.top - cardHeight - 18)}px`
    : `${rect.bottom + 18}px`;
}

function nextTourStep() {
  if (++tourIndex >= TOUR_STEPS.length) return endTour();
  showTourStep();
}

function endTour() {
  tourTarget = null;
  window.removeEventListener("scroll", trackTourStep);
  window.removeEventListener("resize", trackTourStep);
  $("#tour-backdrop").hidden = true;
  localStorage.setItem("sih-tour-done", "1");
}

// Opening this used to mean tearing the app down: clear the session, drop the current
// problem, hide #navbar, #list-view and #detail-view. None of that is needed once the
// form is a modal <dialog> -- showModal() makes the rest of the document inert, so the
// controls behind it leave the tab order on their own and the statement the visitor was
// reading is still there when they press Escape or Back.
function openAuthDialog(message = "") {
  const dialog = $("#access-gate");
  $("#gate-status").textContent = message;
  $("#gate-status").classList.toggle("error", Boolean(message));
  $("#auth-submit").disabled = false;
  if (!dialog.open) dialog.showModal();
}

// Dropping the session leaves the visitor exactly where they are: every statement stays
// readable without an account, so there is nothing to unmount.
function signOutLocal() {
  clearSession();
  state.accessToken = "";
  state.team = null;
  state.reviewCache = {};
  renderTeamBar();
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const action = $("#auth-submit").dataset.mode === "signup" ? "signup" : "login";
  const status = $("#gate-status");
  status.textContent = "";
  status.classList.remove("error");
  busy(form, true, action === "signup" ? "Creating account…" : "Signing in…");
  try {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action, email: $("#auth-email").value, password: $("#auth-password").value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Could not ${action} (${response.status})`);
    if (result.pending) {
      status.textContent = result.message;
      return;
    }
    state.accessToken = result.accessToken;
    state.email = result.email || "";
    state.team = result.team || null;
    saveSession(result);
    $("#auth-password").value = "";
    // The session brings reviews, notes and votes the anonymous view never fetched, so
    // whatever is on screen is re-rendered with them. Behind the still-open dialog: a
    // failure here has to land in #gate-status where the visitor can read it.
    state.reviewCache = {};
    await startApp();
    $("#access-gate").close();
    toast(action === "signup" ? "Account created — welcome" : "Login successful");
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    busy(form, false);
  }
}

async function logout() {
  const button = $("#logout-button");
  button.disabled = true;
  const headers = { "Content-Type": "application/json" };
  if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
  try {
    await fetch("/api/auth", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ action: "logout" }) });
  } catch {
    // The cookie is cleared server-side on any successful call; a network failure
    // still ends the local session below.
  } finally {
    button.disabled = false;
    history.replaceState({}, "", "/");
    // Logging out drops back to anonymous browsing rather than to a wall: the
    // statements were never the thing the account protected.
    signOutLocal();
    state.view = "list";
    route();
    toast("You are logged out.");
  }
}

async function boot() {
  readUrl();
  bindEvents();
  setAuthMode("login");
  // A deep link opens once the dataset is in memory, not before.
  if (location.pathname.startsWith(DETAIL_PREFIX)) pendingRoute = location.pathname;

  // A stored session renders the signed-in app straight away and rotates the token in
  // the background, so a reload never flashes the boot or login screen. An expired
  // stored token still works: the first API call 401s and api() refreshes in place.
  const saved = readSession();
  if (saved) {
    state.accessToken = saved.accessToken;
    state.email = saved.email;
    state.team = saved.team;
    startApp().catch((error) => { toast(error.message, "error"); route(); });
    if (saved.expiresAt - Date.now() < 5 * 60 * 1000) refreshAccessToken().then(renderTeamBar).catch(() => {});
    return;
  }

  // No stored session: browse anonymously. The statements are public Markdown, so the
  // list is never gated -- an anonymous cold load makes exactly one request and never
  // waits on Supabase.
  $("#boot-screen").hidden = false;
  try {
    await startApp();
  } catch (error) {
    toast(error.message, "error");
    route();
  }

  // A refresh cookie can outlive localStorage, so one silent attempt runs after the
  // list is on screen: it restores a returning visitor without a login and costs a
  // first-time one nothing. Failing is the normal case here, so it stays quiet.
  try {
    await refreshAccessToken();
    await startApp();
  } catch {
    // Not signed in. That is a supported way to use the site.
  }
}

boot();
