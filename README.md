# PYQDeck Community API

The community backend for PYQDeck: a LinkedIn-style space where anyone can post (with `#hashtags`) and chat through
comments. It runs **alongside** the main PYQDeck server, which owns papers, syllabus and notes.

|                | Main server (`../server`) | Community server (this repo)           |
| -------------- | ------------------------- | -------------------------------------- |
| Owns           | PYQs, syllabus, notes     | Profiles, posts, comments              |
| Database       | its own MongoDB database  | **its own, separate** MongoDB database |
| Identity       | Clerk                     | **the same Clerk instance**            |
| Webhook secret | its own Clerk webhook     | its own Clerk webhook                  |

Express 5 · TypeScript (ESM) · Mongoose · Zod · Clerk · pino · Vitest. Package manager: **pnpm**.

## Requirements

- Node.js 20+ (22 recommended)
- pnpm 10 (`corepack enable` or `npm i -g pnpm`)
- A MongoDB instance (local or Atlas)
- Access to the Clerk dashboard that the main PYQDeck server uses

## 1. Install

```bash
pnpm install
cp .env.example .env
```

## 2. Configure `.env`

| Variable                       | Required | Description                                                                                                         |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                     | no       | `development` (default), `production`, `test`                                                                       |
| `PORT`                         | no       | Default `5000`                                                                                                      |
| `MONGODB_URI`                  | yes      | **Use a separate database** from the main server, e.g. `mongodb://127.0.0.1:27017/pyqdeck_community`                |
| `CORS_ORIGIN`                  | no       | `*` or a comma separated list of web origins                                                                        |
| `LOG_LEVEL`                    | no       | `fatal` `error` `warn` `info` (default) `debug` `trace` `silent`                                                    |
| `CLERK_PUBLISHABLE_KEY`        | prod     | **Same value as the main server**                                                                                   |
| `CLERK_SECRET_KEY`             | prod     | **Same value as the main server**                                                                                   |
| `CLERK_WEBHOOK_SIGNING_SECRET` | prod     | From the webhook endpoint created for _this_ server (step 3)                                                        |
| `STORAGE_ENCRYPTION_KEY`       | prod     | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts storage account credentials. Required to add accounts |
| `STORAGE_HEADROOM_PERCENT`     | no       | Share of each storage account kept free. Default `5`                                                                |
| `OPENAI_API_KEY`               | prod     | OpenAI key for content moderation. Without it (dev only) moderation is **off** and everything is allowed            |
| `MODERATION_MODEL`             | no       | Default `omni-moderation-latest`                                                                                    |
| `MODERATION_TIMEOUT_MS`        | no       | Default `8000`                                                                                                      |
| `COMMUNITY_ADMIN_EMAILS`       | no       | Comma separated. Accounts with a **verified** Clerk email in this list become `admin` on first sign-in              |

> Why a separate database? Both servers define a `User` model, which maps to a `users` collection. Sharing a database
> would make them overwrite each other. Users are linked only through their Clerk id.

In `production` the three Clerk variables are mandatory and the server refuses to start without them.

## 3. Set up Clerk

Authentication is entirely Clerk. This server never issues tokens or stores passwords.

1. **Reuse the main server's Clerk keys.** Copy `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the main
   server's `.env` into this one. Tokens issued to the PYQDeck apps can only be verified by the same Clerk instance.
2. **Enable usernames** in the Clerk dashboard (_User & authentication → Username_). Without it every user gets a
   handle generated from their email.
3. **Create a webhook for this server.** Clerk supports several endpoints, so this does not affect the main server's.
   - Dashboard → _Webhooks_ → _Add endpoint_
   - URL: `https://<your-community-domain>/api/webhooks/clerk`
   - Events: `user.created`, `user.updated`, `user.deleted`
   - Copy the **Signing Secret** into `CLERK_WEBHOOK_SIGNING_SECRET`
4. _(Optional)_ Turn on **Restrict changes** under _User & authentication_ if you don't want users editing identifiers
   after sign-up. Note that Clerk cannot reserve usernames; the server handles that itself (see below).

### Webhooks while developing locally

Clerk needs a public URL. Use a tunnel and register `https://<tunnel-host>/api/webhooks/clerk` as a **separate,
development** endpoint:

```bash
cloudflared tunnel --url http://localhost:5000
# or
ngrok http 5000
```

Without the webhook the app still works: a profile is created on a user's first request. The webhook only keeps
username, name, avatar and email in sync afterwards, and handles account deletion.

## 4. Run

```bash
pnpm dev          # watch mode with pretty logs
pnpm build        # compile to dist/
pnpm start        # run the compiled build
```

Then open:

- Health check: <http://localhost:5000/api/health>
- Swagger UI: <http://localhost:5000/api/docs> (disabled when `NODE_ENV=production`)
- OpenAPI JSON: <http://localhost:5000/api/docs/json>

## 5. Calling the API from the apps

Send the signed-in user's Clerk session token:

```ts
const token = await getToken(); // Clerk SDK in the app
fetch(`${COMMUNITY_API}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } });
```

Anonymous requests are allowed on public routes. Protected routes return `401` when signed out and `403` for
suspended accounts. Every response carries an `x-request-id` header; error bodies include it as `requestId`, so quote
it when reporting a problem.

### Current endpoints

| Method | Path                   | Auth   | Description                                                      |
| ------ | ---------------------- | ------ | ---------------------------------------------------------------- |
| GET    | `/api/health`          | public | Service and database status                                      |
| GET    | `/api/users/me`        | user   | Own profile (created on first call)                              |
| PATCH  | `/api/users/me`        | user   | Update `headline` and `bio`                                      |
| GET    | `/api/users/:username` | public | Public profile (never includes email)                            |
| POST   | `/api/webhooks/clerk`  | Svix   | Clerk user lifecycle sync (signature verified, not a user route) |

## Image uploads (storage)

Images are stored at an external provider (Cloudinary today) through a pluggable storage layer. Storage accounts are
data, so when one fills up you plug in another without redeploying.

### One-time setup

1. Generate an encryption key for stored credentials and put it in `.env`:
   ```bash
   openssl rand -base64 32
   ```
   ```
   STORAGE_ENCRYPTION_KEY=<the value above>
   ```
2. Sign in as an admin and add your first storage account (the credentials are tested, then stored encrypted):
   ```http
   POST /api/admin/storage/accounts
   Authorization: Bearer <admin Clerk token>

   { "name": "cloudinary-1", "provider": "cloudinary",
     "credentials": { "cloudName": "...", "apiKey": "...", "apiSecret": "..." },
     "capacityBytes": 2147483648, "priority": 1 }
   ```
   `capacityBytes` is a soft limit that you choose; set it a little below what the provider really allows.

### When an account fills up

Nothing breaks: the full account is marked `full` and new uploads go to the next one. If none has room, uploads return
`507`. To add space, create another provider account and repeat the `POST` above with a new `name` (and a higher
`priority` number so the older one is used first). Existing files keep working from the account they live on. Use
`GET /api/admin/storage/accounts` to see usage, `PATCH` to disable or reprioritise, and
`POST /api/admin/storage/accounts/:id/refresh-usage` to re-sync real usage from the provider.

### How the app uploads (direct, no bytes through this server)

1. `POST /api/media/uploads` with `{ "files": [{ "mimeType": "image/png", "size": 123456 }] }` (up to 8). The response
   has one ticket per file: `{ id, upload: { method, url, fields, fileField, expiresAt } }`.
2. Send a multipart `POST` to `upload.url` containing every key of `upload.fields` plus the file in the field named
   `upload.fileField`. This goes straight to the provider.
3. `POST /api/media/:id/complete`. The server asks the provider what actually arrived and rejects (and deletes) anything
   larger than declared or not a JPEG/PNG/WebP. The media is then `pending` until a post uses it; unused uploads are
   removed automatically after about an hour.

`POST /api/media` (multipart, field `files`) still exists as a fallback that passes bytes through this server.

### Adding another provider later (e.g. UploadThing, R2)

Write `src/modules/storage/providers/<name>.provider.ts` implementing `StorageProvider` (plus `DirectUploadProvider`
for direct uploads) and register it in `providers/index.ts`. Nothing else changes. Details are in `AGENTS.md`.

## Content moderation

Everything users submit is checked by the OpenAI Moderation API (`omni-moderation-latest`, free to use) before it can be
published. Images are already covered; posts and comments will use the same service.

**What happens to bad content**

| Situation                                                                                         | Result                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Sexual content, hate, graphic violence, threats, etc.                                             | **Rejected** (`422`), image deleted, event logged                      |
| Borderline: harassment, violence, self-harm, drug content, or a high score just under the cut-off | **Held** (images are rejected until a review queue exists)             |
| Moderation service down, slow, or key invalid                                                     | **Never published**: `503 try again shortly` (images stay `uploading`) |
| Image the checker cannot read (corrupt, unsupported)                                              | Rejected                                                               |
| Sexual content involving minors                                                                   | Rejected **and flagged `escalate`** (see below)                        |

Where the images are checked: multipart uploads are checked **before** being stored (a rejected image never reaches the
storage provider); direct uploads are checked at `POST /api/media/:id/complete`, and a rejected file is deleted from
storage.

**Tuning the rules.** Which categories reject, hold or are ignored is one table, `DEFAULT_POLICY` in
`src/modules/moderation/moderation.policy.ts`. Edit it to match your community guidelines. `nearMissScore` (default
`0.5`) holds content the provider did not flag but scored highly.

**What moderators can see.** `GET /api/moderation/events` (moderators and admins) lists blocked and held items: who,
which category, scores, and `escalate`. The content itself is **never stored**, and events are deleted after 90 days.

**Child safety (`escalate: true`).** Blocking such content is not enough. Decide now who reviews `escalate` events,
how you preserve what law requires, and how you report it (in India, via the national cybercrime reporting portal and
your legal counsel). Treat this as a legal process, not a feature; the API only makes sure it is never published and
is surfaced to you.

**Using it from a new feature** (posts, comments):

```ts
const decision = await getModerationService().moderate(
  { text: post.body, images: [{ url }] },
  { userId, source: "post", sourceId },
);
// allow -> publish | review -> save as pending_review | reject -> 422
// decision.degraded === true means the checker was down: treat like review, never publish.
```

## How identity works

- **Clerk owns identity.** `username`, `displayName`, `avatarUrl` and `email` are copied from Clerk and re-synced by
  the webhook. They cannot be edited through this API. Users change them in Clerk.
- **This server owns community data:** `headline`, `bio`, `role` (`member` / `moderator` / `admin`) and `status`
  (`active` / `suspended` / `deleted`).
- **Reserved names:** Clerk can't block usernames, so a Clerk username such as `admin` or `support` is not adopted as
  the community handle; one is generated from the email. A username never proves staff status. Only `role` does.
- **Deleting a Clerk account** keeps the row (so existing posts keep a valid author), scrubs personal data and frees
  the username. Show such authors as "Deleted user".
- **Admin bootstrap:** list your email in `COMMUNITY_ADMIN_EMAILS`, sign in once, and you're `admin`. Only verified
  emails count, and promotion is one-way: demote someone by editing the database.

## Development

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `pnpm check`         | typecheck + lint + format check + tests (run before PR) |
| `pnpm typecheck`     | `tsc --noEmit`                                          |
| `pnpm lint`          | ESLint (`pnpm lint:fix` to autofix)                     |
| `pnpm format`        | Prettier write (`pnpm format:check` to verify)          |
| `pnpm test`          | Vitest + Supertest on an in-memory MongoDB              |
| `pnpm test:watch`    | Tests in watch mode                                     |
| `pnpm test:coverage` | Tests with coverage                                     |

- The **first** `pnpm test` downloads a MongoDB binary (a few hundred MB) and caches it. Later runs are fast.
- Clerk is mocked in tests, so no Clerk keys are needed to run them.
- A pre-commit hook (husky + lint-staged) formats and lints staged files and runs the typecheck. CI
  (`.github/workflows/ci.yml`) runs typecheck, lint, format check, tests and build on pushes to `main` and on pull
  requests.
- On a deploy or Docker build, install with `pnpm install --frozen-lockfile --ignore-scripts` (the `prepare` script
  installs git hooks, which don't exist there).

## Project layout and conventions

```
src/
├── config/     env (zod-validated), database
├── core/       base repository/service/controller, errors, middleware, utils
├── modules/    one folder per feature: auth, users, health, ...
├── docs/       OpenAPI assembly + Swagger UI
├── routes/     mounts every module under /api
├── app.ts      builds the Express app
└── server.ts   connects the database and listens
```

Each feature follows `routes → validate → controller → service → repository → model`. The full architecture rules
and conventions (pagination, status codes, logging, auth guards, docs, tests) are in [`AGENTS.md`](./AGENTS.md).
Read that before adding a module.

## Production checklist

- [ ] `NODE_ENV=production` and all three Clerk variables set
- [ ] `MONGODB_URI` points at the **community** database, not the main server's
- [ ] Clerk webhook endpoint points at the production URL and its signing secret is set
- [ ] `CORS_ORIGIN` is restricted to your real web origins (not `*`)
- [ ] `COMMUNITY_ADMIN_EMAILS` contains only people who should be admins
- [ ] `STORAGE_ENCRYPTION_KEY` is set and backed up (losing it makes stored storage credentials unreadable)
- [ ] `OPENAI_API_KEY` is set (production refuses to start without it) and you have decided who handles `escalate` events
- [ ] At least one storage account is added, and you know how to add the next one
- [ ] Reverse proxy forwards the **raw** body on `/api/webhooks/clerk` (do not rewrite or re-encode it, or signature
      checks fail)
