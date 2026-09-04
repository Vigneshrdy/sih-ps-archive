<div align="center">

# SIH Selection Desk

### Team-oriented browser for the Smart India Hackathon 2026 problem statements

The 226 statements are read straight from the Markdown in [`2026/`](../2026) — no
database, no build step, nothing to import. Supabase backs only what genuinely needs an
account: email/password Auth with rotating refresh tokens, six-member teams, private
reviews, team votes and per-team comments.

[![License](https://img.shields.io/github/license/DeadIndian/sih-ps-archive?style=flat-square)](../LICENSE)
[![Stars](https://img.shields.io/github/stars/DeadIndian/sih-ps-archive?style=flat-square)](https://github.com/DeadIndian/sih-ps-archive/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](../CONTRIBUTING.md)
![Made with Node.js](https://img.shields.io/badge/made%20with-Node.js-blue?style=flat-square)

[Getting Started](#-installation) ·
[Architecture](ARCHITECTURE.md) ·
[Report Bug](https://github.com/DeadIndian/sih-ps-archive/issues) ·
[Request Feature](https://github.com/DeadIndian/sih-ps-archive/issues)

<img src="../assets/screenshots/hero.png" alt="SIH Selection Desk screenshot" width="80%" />

</div>

---

## 📖 Table of Contents

- [Features](#-features)
- [Screenshots](#-screenshots)
- [Installation](#-installation)
- [Usage](#-usage)
- [Configuration](#-configuration)
- [Deployment](#-deployment)
- [Security Model](#-security-model)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

- **Problem statement browser** — the whole list arrives in one public request and is searched, filtered and sorted in the browser; search accepts both `SIH26011` and `26011`
- **Filters** — theme, organization, category, dataset availability, starred items, hidden rejected items, PS-number range, quick picks
- **Full statement view** — official description, expected solution, organization, department, category, theme, dataset link
- **Server-rendered statement pages** — `/problem-statements/SIH26011` returns real HTML with its own title, description and JSON-LD, so crawlers and link previews work without JavaScript
- **Reads without an account** — statements are public, and opening one never asks for a login; the form is a dismissible dialog that only a save-shaped action opens, with a back button to the statement you were reading
- **Six-member teams** — create or join with name + password, seat 1 is the lead, automatic lead succession, one team per user
- **Reviews** — private per-problem reading state (`to read` / `read`), decision (`keep` / `accept` / `reject`), private note (4000 chars), team votes (`yes` / `maybe` / `no`) with live totals
- **Review board** — status-grouped board, card badges, summary bar, compare up to 4 statements, markdown export
- **Private per-team comments** — visible only to the joined team
- **Hardened session handling** — Supabase Auth with rotating refresh tokens, hashed at rest, bound to IP hash + user agent

## 📸 Screenshots

| Statement list | Full statement view |
| :---: | :---: |
| <img src="../assets/screenshots/list.png" width="100%" /> | <img src="../assets/screenshots/detail.png" width="100%" /> |

| Team dialog | Review board |
| :---: | :---: |
| <img src="../assets/screenshots/team.png" width="100%" /> | <img src="../assets/screenshots/board.png" width="100%" /> |

| Dark theme |
| :---: |
| <img src="../assets/screenshots/dark.png" width="100%" /> |

## 🚀 Installation

> Prerequisites: Node.js ≥ 20. A Supabase project is needed only for accounts, teams,
> reviews and comments — the statements work without one.

```bash
git clone https://github.com/DeadIndian/sih-ps-archive.git
cd sih-ps-archive
npm install
```

### Set up Supabase

1. Open your Supabase project and run [`supabase/schema.sql`](../supabase/schema.sql) in **SQL Editor**. It holds accounts, sessions, teams, reviews, votes and comments — not the statements.
2. In **Project Settings → Database**, copy the **Transaction pooler** connection string (port `6543`).
3. Create a local `.env` from [`.env.example`](../.env.example) and set `DATABASE_URL`.

### Configure Supabase Auth

1. In **Authentication → Providers**, enable **Email**.
2. Disable **Anonymous Sign-Ins** — the app rejects anonymous tokens.
3. Decide on **Confirm email**:
   - **Off** (fastest for a hackathon): signup returns a session and the user lands on the desk immediately.
   - **On**: signup returns `202` and the UI asks the user to confirm, then log in. Both paths are handled.
4. In **Authentication → Bot and Abuse Protection**, leave CAPTCHA **disabled** — the browser sends no captcha token, so an enabled CAPTCHA rejects every sign-in.

## 💻 Usage

```bash
npm run dev        # local dev server at http://localhost:3000
```

Alias: `npm start` does the same. PORT is honored (`PORT=4000 npm run dev`).

`scripts/dev.js` serves the static files and routes `/api/*` to the same handlers Vercel runs, including the `/problem-statements/:id` rewrite, and logs every API request with its status. It adds `http://localhost:3000` to `APP_ORIGIN` for the duration of the process so the origin check passes.

Run the checks:

```bash
npm run check     # offline: statement parser + team rules + guards
npm run check:e2e # full end-to-end flow (needs dev server + .env)
```

### Routes

| Path | View |
| --- | --- |
| `/` | The statement list, for everyone |
| `/problem-statements` | The same list, server-rendered for crawlers |
| `/problem-statements/SIH26011` | One complete problem statement, server-rendered |
| `/api/problems` | All 226 statements as JSON, public, CDN-cached for an hour |
| `/sitemap.xml` | Every statement URL |

`vercel.json` rewrites the `/problem-statements` paths to [`api/statement.js`](../api/statement.js), which injects that statement's metadata and body into `index.html` before sending it. The client-side app then takes over.

## ⚙️ Configuration

| Variable | Description | Required |
| --- | --- | --- |
| `DATABASE_URL` | Supabase transaction pooler connection string (port 6543) | Yes |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Yes |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (server-side only) | Yes |
| `APP_ORIGIN` | Allowed origin(s), comma-separated | Production |
| `SUPABASE_DB_CA_CERT` | Absolute path to Supabase root CA cert | Production |
| `SUPABASE_DB_CA_CERT_PEM` | PEM contents of the CA cert (alternative to the above) | Production |

Production refuses to connect to Postgres without a verified CA. Keep any `service_role` or `sb_secret_*` key out of the browser, GitHub, and public Vercel variables.

## 🌐 Deployment

1. Push the project without `.env` (`git ls-files ps.json` must also print nothing).
2. Import the repository into Vercel.
3. Add all environment variables to Production and Preview environments.
4. Deploy and connect the custom domain.
5. Set `APP_ORIGIN` to the final domain, then redeploy.

`vercel.json` carries the one non-obvious deployment requirement: `functions[].includeFiles` is what physically puts `2026/**` (and `index.html`) inside the deployed function bundles. The functions import the Markdown at runtime rather than statically, so without those entries the build succeeds and every statement page 404s in production only. [`scripts/checks/guards.mjs`](../scripts/checks/guards.mjs) asserts they are present.

### Migrating an existing deployment

A deployment that previously served statements from Postgres has two now-unused tables. The app ignores them, so this is optional cleanup — run it only after the new deployment is live and verified.

```sql
-- Destructive and irreversible. The statements live in 2026/*.md now; this drops the
-- copies in Postgres. Reviews, votes and comments keep their ps_number values, which are
-- plain TEXT with no foreign key, so nothing here touches user data.
ALTER TABLE group_comments       DROP CONSTRAINT IF EXISTS group_comments_ps_number_fkey;
ALTER TABLE user_problem_reviews DROP CONSTRAINT IF EXISTS user_problem_reviews_ps_number_fkey;
ALTER TABLE team_problem_votes   DROP CONSTRAINT IF EXISTS team_problem_votes_ps_number_fkey;
DROP TABLE IF EXISTS statement_accesses;
DROP TABLE IF EXISTS problem_statements;
```

### Put Cloudflare in front

Proxy the domain through Cloudflare with SSL/TLS mode **Full (strict)**. Minimum WAF rate-limit rules:

| Endpoint | Suggested limit | Action |
| --- | ---: | --- |
| `POST /api/auth` | 10 requests/IP/10 minutes | Managed Challenge |
| `POST /api/team` | 5 requests/IP/15 minutes | Block for 1 hour |
| `POST /api/comments*` | 10 requests/IP/minute | Block for 10 minutes |

Also enable Bot Fight Mode. The account-backed routes additionally rate-limit per account in Postgres, so changing IP alone does not bypass those limits. `GET /api/problems` needs no rule: it is one public response, identical for everyone, served from the CDN.

## 🔒 Security Model

The problem statements are public. They are published by SIH, they are committed to this
repository in Markdown, and every one of them is server-rendered for crawlers — so there
is nothing for an access gate to protect, and the previous one is gone.

What stays closed is everything tied to an account:

| Route | Caller |
| --- | --- |
| `GET /api/problems`, `/problem-statements/*`, `/sitemap.xml` | Anyone |
| `/api/reviews`, `/api/team`, `/api/comments` | Verified Supabase access token, else `401` |

Private notes, decisions, votes and comments are scoped to the account or the joined team in SQL on every read and write. Direct client access to Postgres is off: RLS is enabled and `anon` and `authenticated` have `REVOKE ALL` on every table, so the API functions are the only way in. Team size is capped by the database itself — `CHECK (seat BETWEEN 1 AND 6)` plus `UNIQUE (team_id, seat)` make a seventh row impossible to insert. Where enforcement lives, and why RLS is not the primary control, is in [ARCHITECTURE.md](ARCHITECTURE.md#security-model).

## 🤝 Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](../CONTRIBUTING.md) and the [Code of Conduct](../CODE_OF_CONDUCT.md) before opening a PR.

## 👥 Contributors

- **[Vignesh Reddy](https://github.com/Vigneshrdy)** — original author of the app
- **[DeadIndian](https://github.com/DeadIndian)** — archive and app maintainer

## 📄 License

The app code is MIT — see [LICENSE](../LICENSE). The problem statement text in `2024/`,
`2025/` and `2026/` is not the app's to license; see [ATTRIBUTION.md](../ATTRIBUTION.md).

---

<div align="center">
<sub>Architecture notes in <a href="ARCHITECTURE.md">ARCHITECTURE.md</a></sub>
</div>

