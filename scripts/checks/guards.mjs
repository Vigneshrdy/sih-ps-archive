import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCookies, validOrigin } from "../../lib/http.js";

// Cookie parsing: duplicates, malformed pairs, bad encoding.
assert.equal(parseCookies({ headers: { cookie: "a=1; b=2" } }).b, "2");
assert.equal(parseCookies({ headers: { cookie: "sih_refresh=old; sih_refresh=new" } }).sih_refresh, "new", "last duplicate wins (browser sends longest path first)");
assert.deepEqual(parseCookies({ headers: { cookie: "novalue; =x; a=1" } }), { a: "1" }, "malformed pairs skipped");
assert.equal(parseCookies({ headers: { cookie: "a=%E0%A4%A" } }).a, "%E0%A4%A", "bad percent-encoding does not throw");
assert.deepEqual(parseCookies({ headers: {} }), {});

// Origin check: a missing header must not pass once APP_ORIGIN is configured.
const withOrigin = (o) => ({ headers: o === undefined ? {} : { origin: o } });
process.env.APP_ORIGIN = "https://sih.saireddy.dev";
assert.equal(validOrigin(withOrigin("https://sih.saireddy.dev")), true, "configured origin allowed");
assert.equal(validOrigin(withOrigin("https://evil.example")), false, "foreign origin rejected");
assert.equal(validOrigin(withOrigin(undefined)), false, "missing Origin rejected when configured");
process.env.APP_ORIGIN = "";
assert.equal(validOrigin(withOrigin(undefined)), true, "unconfigured deployment still runs");

// The refresh cookie must expire the legacy path too, or it can never be deleted.
const session = fs.readFileSync(new URL("../../lib/session.js", import.meta.url), "utf8");
for (const fn of ["setRefreshCookie", "clearRefreshCookie"]) {
  const body = session.slice(session.indexOf(`function ${fn}`));
  assert.match(body.slice(0, 400), /LEGACY_COOKIE_PATH/, `${fn} clears the legacy cookie path`);
}
assert.match(session, /if \(data\.user\.is_anonymous\) \{\s*\n\s*clearRefreshCookie\(response\);\s*\n\s*return null;/, "anonymous refresh tokens refused");
assert.match(session, /export async function endSessionByRefreshToken\(request, response\)/, "logout can revoke by refresh token alone");
assert.doesNotMatch(session, /Max-Age=0; Secure"/, "clear cookie no longer hardcodes Secure (broke local http)");

// DB TLS must fail closed in production instead of silently disabling verification.
const db = fs.readFileSync(new URL("../../lib/db.js", import.meta.url), "utf8");
assert.match(db, /SUPABASE_DB_CA_CERT_PEM/, "inline PEM configuration supported");
assert.match(db, /ssl: ca \? \{ ca, rejectUnauthorized: true \} : \{ rejectUnauthorized: false \}/, "DB uses verified TLS when a CA is configured and falls back otherwise");

// The CSP has no 'unsafe-inline', so any inline executable <script> in index.html is
// dead code. A saved dark theme silently reverted to light on reload because of
// exactly that. JSON-LD data blocks are exempt: they are never executed, so
// script-src does not block them and Googlebot still reads them from the DOM.
const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
assert.doesNotMatch(html, /<script(?![^>]*\b(?:src=|type="application\/ld\+json"))/, "no inline executable scripts (CSP script-src 'self' blocks them)");
assert.match(html, /<script src="\/theme-init\.js"><\/script>/, "theme restored from an external script before paint");

// The statements come from this repository's own Markdown, not from Postgres. Fetching
// a static /ps.json instead silently emptied the site once, because ps.json is
// gitignored and therefore never deployed -- the same failure mode is why the parser
// reads committed files.
const app = fs.readFileSync(new URL("../../app.js", import.meta.url), "utf8");
assert.match(app, /fetch\("\/api\/problems"\)/, "statements load from the public bulk endpoint");
assert.doesNotMatch(app, /api\("\/api\/problems/, "the list is public: no bearer token, so a cold anonymous load cannot trip the refresh path");
assert.doesNotMatch(app, /fetch\("\/ps\.json"\)/, "no dependency on the undeployed ps.json");

// One reader of the Markdown, and it is the only place that knows the file layout.
const listApi = fs.readFileSync(new URL("../../api/problems/index.js", import.meta.url), "utf8");
const sitemap = fs.readFileSync(new URL("../../api/sitemap.js", import.meta.url), "utf8");
const statement = fs.readFileSync(new URL("../../api/statement.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
for (const [name, source] of [["problems", listApi], ["sitemap", sitemap], ["statement", statement]]) {
  assert.match(source, /from "\.\.\/(\.\.\/)?lib\/statements\.js"/, `api/${name} reads statements through lib/statements.js`);
  assert.doesNotMatch(source, /lib\/db\.js/, `api/${name} is public: no database, no session`);
  assert.doesNotMatch(source, /2026\//, `api/${name} does not reach for the Markdown itself`);
}
for (const [name, source] of [["api/statement.js", statement], ["api/sitemap.js", sitemap], ["api/problems/index.js", listApi], ["supabase/schema.sql", schema]]) {
  assert.doesNotMatch(source, /problem_statements|statement_accesses/, `${name} no longer references the dropped tables`);
}
assert.match(listApi, /s-maxage=3600/, "the one identical-for-everyone API response is CDN-cached");

// api/statement.js rewrites the shell's metadata by matching exact tags in
// index.html. A reformat there would silently serve homepage metadata on all 226
// statement pages, so every anchor it depends on is asserted here.
for (const anchor of [
  '<link rel="canonical" href="https://sih.saireddy.dev/" />',
  '<meta name="description" content="',
  '<section class="access-gate access-gate-loading" id="boot-screen"',
  '<article class="detail-view" id="detail-view" hidden',
  '<div class="detail-body" id="detail-body">',
  '<h1 id="page-title">',
  "<body>",
]) assert.ok(html.includes(anchor), `index.html keeps the anchor api/statement.js rewrites: ${anchor}`);
assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, "exactly one h1 in the shell");

// The navbar carries the work: search and the filter trigger live inside <header>, not
// inside #list-view. The tour depends on that -- it spotlights #filter-button because it
// is positioned from a live rect and the drawer's own controls are offscreen.
const navbar = html.slice(html.indexOf('<header class="navbar"'), html.indexOf("</header>"));
for (const id of ['id="search"', 'id="filter-button"', 'id="join-group-button"']) {
  assert.ok(navbar.includes(id), `the navbar carries ${id}`);
}

// Reading a problem statement needs no account, and asking for one has to leave the
// statement on screen. loadReview() is the sibling loadReviewsForProblems() already
// guarded: without the same check, opening a statement anonymously hit api()'s account
// offer and showDetail()'s catch overwrote the official text with an error.
assert.doesNotMatch(app, /function showGate\b/, "signing in is an on-demand dialog, not a gate that unmounts the app");
assert.match(html, /<dialog class="auth-dialog" id="access-gate"/, "the login form is a dismissible modal");
assert.ok(html.includes('id="auth-back"'), "the login dialog offers a way back to the statements");
assert.match(app, /function openAuthDialog[\s\S]{0,400}dialog\.showModal\(\)/,
  "showModal() supplies the focus trap and inert background the old gate faked by hiding #navbar");
const loadReview = app.slice(app.indexOf("async function loadReview(id)"), app.indexOf("async function saveReview"));
assert.match(loadReview, /if \(!state\.accessToken\) return emptyReview\(\)/, "opening a statement never asks for a login");
assert.match(loadReview, /catch \{\s*\n\s*return emptyReview\(\)/, "a dead review read leaves the rendered statement alone");
assert.match(app, /async function loadReviewsForProblems[\s\S]*?if \(!state\.accessToken\) return/, "list badges stay anonymous too");

// No build step, so a renamed id in index.html is only caught at runtime -- and
// bindEvents() runs at boot, where addEventListener on null blanks the whole page.
// Everything it reaches for must exist in the shell. Ids created by detailTemplate()
// are not checked here because they do not exist until a statement is opened.
const shellIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const bindEvents = app.slice(app.indexOf("function bindEvents"), app.indexOf("function openStatement"));
for (const [, id] of bindEvents.matchAll(/\$\("#([\w-]+)"\)/g)) {
  assert.ok(shellIds.has(id), `bindEvents() binds #${id}, which index.html must define`);
}

// .detail-bar sticks directly beneath the sticky navbar. Two literals would drift apart
// at the breakpoint where the bar wraps to two rows, so both read one variable.
const css = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
for (const rule of [/^\.navbar \{[^}]*height: var\(--nav-h\)/m, /^\.detail-bar \{[^}]*top: var\(--nav-h\)/m, /^\.filters \{[^}]*top: var\(--nav-h\)/m]) {
  assert.match(css, rule, "the sticky bars share --nav-h instead of repeating a magic number");
}

// api/statement.js steps <h1 id="page-title"> down to an h2, and an anonymous visitor
// can walk back from a rendered statement to the list, so the list heading has to be
// styled by id as well as by tag or it loses its type on the way back.
assert.match(css, /^\.page-head h1, \.page-head #page-title \{/m, "the list heading is styled by id as well as by tag");
assert.match(css, /^dialog\.auth-dialog \{/m, "the login dialog is sized as a dialog, not as the full-screen boot panel");

assert.match(statement, /s-maxage=3600/, "statement pages are CDN-cached, not rendered per crawl");
const vercel = JSON.parse(fs.readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
assert.deepEqual(vercel.rewrites.map((r) => r.destination),
  ["/api/statement", "/api/statement?id=:id", "/api/sitemap"], "public routes reach the renderers");

// includeFiles is what puts the Markdown inside the deployed function. Without it the
// functions build fine and every statement page 404s in production only.
assert.equal(vercel.functions["api/statement.js"].includeFiles, "{index.html,2026/**}", "the shell and the statements ship with the function that reads both");
for (const fn of ["api/problems/index.js", "api/sitemap.js"]) {
  assert.equal(vercel.functions[fn].includeFiles, "2026/**", `${fn} ships with the statements it parses`);
}

// Vercel applies the last matching header rule per key, so the public cache rule for
// the statement list is only effective while it sits after the blanket /api/ no-store.
const sources = vercel.headers.map((rule) => rule.source);
assert.ok(sources.indexOf("/api/problems") > sources.indexOf("/api/(.*)"), "the /api/problems cache rule overrides the blanket no-store, not the reverse");

console.log("guard checks passed");
