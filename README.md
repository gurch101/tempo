# Tempo

Tempo is a private daily activity dashboard for timers, habits, nutrition, strength training, Cardio, Sleep, and personal portfolio tracking. The browser UI remains dependency-free vanilla HTML/CSS/JavaScript; a Hono Worker and Cloudflare D1 provide authoritative persistence.

Each private area has a capability URL in the form `/p/<secret>`. Possession of that URL grants full access. Tempo stores only the SHA-256 hash of the secret in D1, so there is no account recovery if the URL and the browser's remembered pointer are both lost.

## Local development

Requirements: Node.js 22+ and npm.

```sh
npm install
npm run db:pull:production
npm run migrate:local
npm run dev
```

The production pull is read-only and copies the remote database to `.wrangler/production-snapshot`. Both `migrate:local` and `dev` use that same local snapshot, so starting the regular development server preserves and reuses the pulled data. Run `npm run dev:production-snapshot` to pull, migrate, and start the server in one command. Wrangler prints the local URL.

Useful checks:

```sh
npm run typecheck
npm test
npm run cf-typegen # rerun after changing Wrangler bindings or environments
```

## D1 administration

Tempo mounts the sibling `d1-admin` package at `/admin`. The package discovers the bound D1 schema at runtime and provides row browsing and safe CRUD without application model definitions. Sensitive credential and capability columns are masked through optional metadata overrides.

For local development, set `D1_ADMIN_DEV=true` in the untracked `.dev.vars`; the bypass is accepted only on localhost. Deployed environments fail closed unless `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are configured and the request contains a valid Cloudflare Access assertion. Configure a self-hosted Access application for both `/admin` and `/admin/*`. Never enable `D1_ADMIN_DEV` in preview or production.

## Data model and API

The checked-in migrations under `migrations/` create normalized tables for spaces, timers and daily logs, habits and daily logs, nutrition, foods/meals/log entries, complete strength history, Google Health data, portfolio holdings, cached market quotes, daily closes, and foreign-exchange history. Every table has an `INTEGER PRIMARY KEY AUTOINCREMENT`; entity relationships use those integer IDs, dates remain text, timestamps are Unix milliseconds, numeric values are real numbers, and ownership indexes begin with `space_id`.

The Worker exposes:

- `POST /api/spaces` to create a capability URL
- `GET /api/bootstrap` and `GET|PUT /api/state` for the v13 UI read model and Settings editor
- timer, habit, food, meal, nutrition, workout, mesocycle, and workout-session routes

Authenticated requests send `Authorization: Bearer <capability>` and mutations send the latest revision through `If-Match`. A stale mutation receives `412 Precondition Failed`; the browser reloads the authoritative snapshot and asks the user to repeat the edit.

Running timers persist a checkpoint immediately. Elapsed time is reconciled on the Worker across dates and scheduled weekdays using the private area's fixed IANA timezone. The browser animates between checkpoints without per-second writes.

## Google Health, Cardio, and Sleep

Tempo uses the Google Health API's `daily-resting-heart-rate`, `exercise`, `heart-rate`, and `sleep` data types. Only treadmill exercise types are imported. Sleep imports include the authoritative asleep duration and stage segments. A deployment has one Google OAuth web client; users only press **Connect Google Health** and grant access in Google's consent flow. Each private area stores its own refresh token encrypted with AES-GCM in D1. OAuth client credentials and the encryption key never enter D1 or the browser.

Create a Google OAuth web client and add each deployed callback URL as an authorized redirect URI:

```text
https://<preview-host>/api/google-health/callback
https://<production-host>/api/google-health/callback
```

In the Google Cloud console, enable the Google Health API, configure the OAuth consent screen and requested scopes, and create a Web Server OAuth client. Add test users while the app is in Testing mode. Google documents that refresh tokens issued in Testing mode expire after seven days. Public apps using Google Health's restricted scopes must complete Google's verification and security-assessment requirements.

Configure the shared credentials as Cloudflare Worker secrets for preview:

```sh
npx wrangler secret put GOOGLE_HEALTH_CLIENT_ID
npx wrangler secret put GOOGLE_HEALTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_HEALTH_TOKEN_KEY
```

Repeat each command with `--env production` for production. `GOOGLE_HEALTH_TOKEN_KEY` must be 32 random bytes encoded as base64url. Generate one with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

For local development, put the same three names in an untracked `.dev.vars` file. Do not reuse the preview token-encryption key in production; changing a deployed key makes existing encrypted refresh tokens unreadable and requires users to reconnect.

Cardio and Sleep load their saved data from D1, then sync automatically when their page is visited unless that data was synced within the previous five minutes. The Worker refreshes the Google access token and imports only changes: new daily rows are inserted, changed daily values are updated, unchanged sessions are skipped, and session details are replaced only when Google reports a newer `updateTime`.

| Method | URI | Description |
| --- | --- | --- |
| `POST` | `/api/google-health/connect` | Creates a one-time OAuth state and returns the Google authorization URL. |
| `GET` | `/api/google-health/callback` | Validates the OAuth callback, encrypts the refresh token, and returns to the initiating page. |
| `GET` | `/api/cardio` | Reads connection metadata, resting heart rates, and treadmill summaries from D1 only. |
| `GET` | `/api/cardio/sessions/:id` | Reads one owned treadmill session and its heart-rate samples from D1 only. |
| `POST` | `/api/cardio/sync` | Refreshes OAuth, imports Cardio data into D1, and returns the refreshed D1 model. |
| `GET` | `/api/sleep` | Reads sleep sessions and their stage segments from D1 only. |
| `POST` | `/api/sleep/sync` | Refreshes OAuth, imports up to a year of Sleep data into D1, and returns the refreshed D1 model. |

## Finances

Finances stores stock and cash holdings per private area. Stock tickers are unique within a portfolio, while multiple cash rows may use the same currency. The display currency defaults to CAD and can be changed in Settings. Quantities and cash balances remain private to each space, while stock quotes, stock history, and FX data are shared globally because they contain no private user data. Current totals and comparisons load entirely from D1.

Yahoo Finance is contacted automatically when Finances is visited, unless prices were refreshed within the previous five minutes, and immediately after a holding is added or updated. Tempo uses the `yahoo-finance2` package's chart module to read current prices, daily closes, security currency, and currency pairs. Current quote rows are updated, while historical stock and FX rows are append-only: only dates after the latest stored date for each series are inserted. Yahoo Finance remains an unofficial data source, so refresh failures leave all previously cached values untouched and are shown to the user.

| Method | URI | Description |
| --- | --- | --- |
| `GET` | `/api/finances` | Reads holdings, cached valuations, and historical comparisons from D1. |
| `POST` | `/api/finances/holdings` | Adds a stock ticker or currency cash balance. |
| `PUT` / `DELETE` | `/api/finances/holdings/:id` | Updates a holding quantity or removes the holding. |
| `PUT` | `/api/finances/currency` | Changes the portfolio display currency. |
| `POST` | `/api/finances/refresh` | Pulls current and daily Yahoo Finance chart data and stores normalized prices and FX rates. |

## Preview and production setup

Create the two databases once, then copy the returned IDs into `wrangler.toml`:

```sh
npx wrangler d1 create tempo-preview
npx wrangler d1 create tempo-production
```

Apply and deploy preview:

```sh
npm run migrate:preview
npm run deploy:preview
```

Apply and deploy production:

```sh
npx wrangler d1 export tempo-production --remote --output tempo-production-backup.sql
npm run migrate:production
npm run deploy:production
```

After deployment, verify `/`, a bookmarked private URL, an unauthorized API request, static assets, one state write, timer refresh recovery, and JSON import.

## Rollback

Workers deployments are versioned. If application code must be rolled back, use Cloudflare's deployment/version rollback before making further writes. D1 migrations are forward-only; restore the pre-migration export into a replacement database, update the production binding, and redeploy. Never log capability paths, access keys, or authorization headers.

## Import JSON state

State is stored as normalized D1 rows; `spaces` does not contain a JSON state document. To load an exported v13 JSON file into an empty private area, run the Worker and use:

```sh
npm run import:json -- ./tempo-state.json --url http://localhost:8787/p/<capability>
```

The same command works against a deployed preview or production URL. It refuses to overwrite a non-empty area and sends the JSON through the normal revision-checked state endpoint, server validation, and transactional relational writer. This administrative import is intentionally not tracked or idempotent; retry only after confirming the target remains empty. You may set `TEMPO_PRIVATE_URL` instead of passing `--url`.
