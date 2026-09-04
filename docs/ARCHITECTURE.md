# Architecture

SIH Selection Desk: a static frontend + Vercel serverless functions. The problem
statements come from this repository's own Markdown; Supabase Postgres and Supabase
email/password Auth back only the account features. No framework, no build step.

## Layout

```
2026/SIHxxxxx.md                   the 226 statements — the only source of statement data
index.html / app.js / styles.css   static frontend (vanilla JS, client-side routing)
api/                               Vercel serverless functions
  auth.js                          login / signup / logout
  session/refresh.js               restores a session from the HttpOnly cookie
  problems/index.js                all 226 statements as JSON — public, CDN-cached
  statement.js                     server-rendered statement pages for crawlers
  sitemap.js                       /sitemap.xml
  team.js                          create / join / leave team
  reviews.js                       reading state, decision, votes
  comments/index.js                team-private comments
lib/
  statements.js                    the only reader of 2026/*.md — parse once, cache
  db.js                            pg pool → Supabase transaction pooler (port 6543)
  session.js                       JWT verification, refresh rotation, team summary
  http.js                          JSON helper, cookie parser, origin check
supabase/schema.sql                the schema for accounts, teams, reviews, comments
scripts/
  dev.js                           local dev server mimicking the Vercel runtime
  test-statements.js               offline checks (the Markdown parser, against 2026/)
  test-team.js                     offline checks (team rules, CSS guards)
  checks/guards.mjs                offline checks (the wiring this design depends on)
  checks/*.mjs                     diagnostics — touch the real database, not a test suite
```

The statements are read with `fs.readdirSync`/`readFileSync` at runtime, not imported, so
they only reach production because `vercel.json` lists `2026/**` under
`functions[].includeFiles`. Parsing all 226 files costs one pass per function instance;
`lib/statements.js` caches the result at module scope and hands out the same array after
that.

## Request flow

Statements — no session, no database, no origin check:

```
browser or crawler → Vercel CDN (s-maxage=3600)
  → function → lib/statements.js (module-scope cache)
  → 2026/*.md
```

Everything account-backed:

```
browser → Bearer access token → Vercel function
  → jwtVerify against Supabase JWKS (jose, cached 10 min)
  → browse_sessions row must exist, unrevoked, unexpired
  → per-account rate limit in Postgres
  → pg pool → transaction pooler → Postgres
```

The browser never talks to Supabase directly. Functions hold the publishable
key and open their own Postgres connection.

## Sessions

Supabase issues and refreshes the JWT; this app never creates its own.
Refresh tokens are opaque, stored in a secure HTTP-only cookie, hashed
(sha256) in Postgres, and rotated on every refresh — the token is bound to an
IP hash and user agent. Anonymous tokens (`is_anonymous`) are refused at both
`verifyAccess` and `rotateSession`. `verifyAccess` only returns `null` for
missing/malformed/expired tokens; a database failure throws a 500 so the
client keeps its session instead of being told it is signed out.

## Security model

The problem statements are public and there is no gate on them. They are published by
SIH, committed to this repository as Markdown, and server-rendered for crawlers, so a
gate would have protected nothing while costing every reader a login. Reviews, notes,
votes, comments and team membership stay behind a verified access token.

On the client that means the login form is an on-demand modal `<dialog>`, not a screen
the app boots into: opening a statement never asks for it, because the per-account
review read is skipped without a token instead of being allowed to fail. Only a pressed
account action opens it — saving a review, a private note, a team vote, or creating and
joining a team — and its back button (or Escape) hands the visitor back to whatever they
were reading, still mounted underneath.

Where the enforcement actually lives:

- **RLS policies are not the control here.** `anon` and `authenticated` have
  `REVOKE ALL` on every table, so the PostgREST path is closed outright rather
  than filtered — strictly tighter than a policy. RLS is left enabled as a
  backstop. If direct browser-to-Supabase queries are ever added, real
  policies must be written first; the `REVOKE` is what protects the data today.
- **Team limits are database constraints, not handler checks.**
  `team_members.seat` carries `CHECK (seat BETWEEN 1 AND 6)` and
  `UNIQUE (team_id, seat)`, so a seventh row cannot be inserted even by a
  direct SQL write. `PRIMARY KEY (team_id, user_id)` blocks duplicate joins, a
  partial unique index blocks a second team lead, and `user_id` has a foreign
  key to `auth.users`.
- **`ps_number` is validated, not referenced.** Postgres holds no statement table, so
  the review, vote and comment tables carry a plain `TEXT ps_number` with no foreign
  key. The handlers accept only `/^SIH\d{5}$/`; an id that no longer exists in `2026/`
  is simply a row nothing renders.

Production refuses to connect to Postgres without a verified CA
(`SUPABASE_DB_CA_CERT` or `SUPABASE_DB_CA_CERT_PEM`).

## Teams

Seat 1 is the team lead; a joiner takes the lowest free seat, so a vacated
seat is reused. When the lead leaves, the remaining member with the lowest
seat inherits the role; when the last member leaves, the team row is deleted.
Team names are unique deployment-wide (case-insensitive); team passwords are
salted and scrypt-hashed. `group_key` has no foreign key, so deleting a team
leaves historical team notes in Postgres under the old team id (unreachable,
harmless).

## Resilience notes

Supabase's shared transaction pooler intermittently drops a connection while
the pool is still opening it. Three deliberate choices keep that from logging
people out:

- `lib/db.js` retries once when a query fails before reaching the server (no
  SQLSTATE `code` + `Connection terminated` message). A real SQL error always
  carries a code and is never retried.
- `verifyAccess` lets database failures throw rather than return `null`.
- `rotateSession` sends the new refresh cookie to the browser *before* writing
  to Postgres. Supabase invalidates the old token the moment it issues a new
  one, so persisting the cookie last would strand the session permanently
  whenever that write failed.

On the client, a failed refresh is not an error state: the app renders the list for a
guest and shows the sign-in panel only when a private feature is used. A `401` from
`/api/session/refresh` therefore ends the session silently; any other failure is retried
once and then reported without dropping it.

## Supabase dashboard settings that affect behavior

- `mailer_autoconfirm` — email confirmation on/off; both signup paths are
  handled by the UI. Off = straight in after signup (best for a hackathon).
- `external.anonymous_users` — keep **off**. The app rejects anonymous tokens;
  leaving it on enabled the stale-anonymous-cookie logout bug.
- CAPTCHA — keep **disabled**; the browser sends no captcha token.

## Gotchas

- Restart `scripts/dev.js` after editing anything in `api/` or `lib/` — it
  caches dynamic `import()`s.
- The shared pooler is genuinely flaky (`Connection terminated due to
  connection timeout`). If a browser test fails oddly, check the server log
  before suspecting the code.
- Supabase rejects `@example.com` on signup and sends a real email per signup
  (~2/hour limit). Test accounts are created directly in `auth.users` via
  `scripts/checks/make-test-account.mjs` — a hand-made `auth.users` row needs
  all the token columns set to `''` **and** a matching `auth.identities` row,
  or GoToTrue fails with "Database error querying schema".
- With `APP_ORIGIN` set, a POST with no `Origin` header is rejected — use
  `-H "Origin: …"` in curl.
- `scripts/checks/` diagnostics all need `--env-file=.env` and touch the real
  database. `npm run check` is the committed offline suite: the statement parser,
  the team rules, and the guards.
- Editing a statement means editing its Markdown and redeploying. There is no
  admin path and no cache to bust beyond the CDN's hour.
