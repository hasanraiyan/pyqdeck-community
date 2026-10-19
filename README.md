# PYQDeck Community API

The community backend for PYQDeck: a LinkedIn-style space where anyone can post (with `#hashtags`) and chat through
comments. It runs **alongside** the main PYQDeck server, which owns papers, syllabus and notes.

|                | Main server (`../server`) | Community server (this repo)                  |
| -------------- | ------------------------- | --------------------------------------------- |
| Owns           | PYQs, syllabus, notes     | Communities, profiles, posts, comments, links |
| Database       | its own MongoDB database  | **its own, separate** MongoDB database        |
| Identity       | Clerk                     | **the same Clerk instance**                   |
| Webhook secret | its own Clerk webhook     | its own Clerk webhook                         |

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
   - URL: `https://community-api.pyqdeck.in/api/webhooks/clerk` (production)
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

One deployment serves many independent communities (`beu`, `gate`, `jee`, ...). Everything a member sees lives under
`/api/v1/communities/{community}`. Send the signed-in user's Clerk session token:

```ts
const token = await getToken(); // Clerk SDK in the app
fetch(`${COMMUNITY_API}/api/v1/communities/beu/posts`, { headers: { Authorization: `Bearer ${token}` } });
```

Most apps should use the typed SDK instead (see [The SDK and the Expo app](#the-sdk-and-the-expo-app)).

Reading is public; writing needs sign-in (`401` when signed out, `403` when suspended in that community or when the
community is read-only). Every response carries an `x-request-id` header; error bodies are
`{ success: false, message, code, requestId, details? }` where `code` is stable (`not_found`, `unauthorized`,
`too_many_requests`, `unprocessable_entity`, ...). Rate limits answer `429` with `Retry-After`. Lists use cursor pages:
`?cursor=&limit=` and `pagination: { nextCursor, hasMore }`.

### Endpoints

All paths below are relative to `/api/v1/communities/{community}` unless they start with `/api`. The full, always
current list is the Swagger UI at `/api/docs`.

| Area          | Endpoints                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Community     | `GET /` (name, status, limits)                                                                                                                                                                         |
| Posts         | `GET /posts` (feed; `hashtag`, `q`), `POST /posts`, `GET /posts/{id or slug}`, `PATCH`, `DELETE`, `PUT/DELETE /posts/{id}/hide`, `GET /hashtags/trending`                                              |
| Reactions     | `PUT/DELETE /posts/{id}/like`, `PUT/DELETE /posts/{id}/bookmark`, `PUT/DELETE /comments/{id}/like`, `GET /members/me/bookmarks`                                                                        |
| Comments      | `GET/POST /posts/{id}/comments`, `GET /comments/{id}/replies`, `PATCH/DELETE /comments/{id}`                                                                                                           |
| Members       | `GET/PATCH /members/me`, `GET /members/{handle}`, `GET /members/{handle}/posts`, `/followers`, `/following`, `GET /members/search?q=`                                                                  |
| Social        | `PUT/DELETE /members/{handle}/follow`, `PUT/DELETE /members/{handle}/block`, `GET /members/me/blocked`                                                                                                 |
| Notifications | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read-all`, `PATCH/DELETE /notifications/{id}`                                                                            |
| Media         | `POST /media/uploads`, `POST /media/{id}/complete`, `DELETE /media/{id}` (direct upload, see below)                                                                                                    |
| Reports       | `POST /reports`; moderators: `GET /reports`, `POST /reports/resolve`                                                                                                                                   |
| Moderation    | `GET /posts/queue`, `GET /comments/queue`, `POST /posts/{id}/moderate`, `POST /comments/{id}/moderate`, `PUT/DELETE /members/{handle}/suspend`, `PUT /members/{handle}/role`, `GET /moderation/events` |
| Links         | `GET /links/{code}` (host and verdict), moderators: `POST/DELETE /links/{code}/block`, `/links/blocked-domains/list`                                                                                   |
| Platform      | `/api/v1/admin/communities` (create, update, set status), `/api/v1/admin/storage/*`, `/api/v1/admin/blocked-domains`, `/api/health`, `/api/webhooks/clerk`                                             |

Important behaviours:

- **Edit and delete your own posts and comments.** A delete hides everything at once and removes the images; the row is
  purged after 30 days. An edit is moderated again; if it is held, the previous text stays live (`hasPendingEdit`).
- **Held content.** Moderation can answer allow / hold / reject. Held posts and comments are visible only to their
  author until a moderator approves them. If the moderation provider is down, content is held, never published.
- **Idempotent creates.** Send `Idempotency-Key` on `POST /posts` and `POST /comments`; a retry returns the original.
- **Roles are per community.** A member, moderator or community admin in `beu` has no powers in `gate`. Platform admins
  (verified emails in `COMMUNITY_ADMIN_EMAILS`) manage communities and storage.

## Communities (multi-tenant)

A **community** is an isolated space, one per PYQDeck app. A person has a separate, **unlinked** membership (handle,
name, avatar, bio, counters) in each one, prefilled from their Clerk profile the first time they act there. Every
community-scoped record carries its community and every repository query is scoped by it (`ScopedRepository`), so data
cannot leak across communities; `tests/integration/social.test.ts` proves it endpoint by endpoint.

- Communities listed in `SEED_COMMUNITIES` (default `beu`) are created on boot if missing.
- A platform admin manages the rest at runtime, no redeploy:
  ```http
  POST /api/v1/admin/communities     { "slug": "gate", "name": "GATE Aspirants", "limits": { "maxImagesPerPost": 5 } }
  PUT  /api/v1/admin/communities/gate/status   { "status": "read_only" }   # active | read_only | disabled
  ```
  `disabled` communities answer `404` as if they did not exist; `read_only` ones keep serving reads.
- **Do not launch a community with under-18 members (`jee`, `neet`) before the legal review** described in
  `docs/SRS.md` (NFR-COMP-5).

## Short links (`go.pyqdeck.in`)

Every external `http(s)` URL in a post, comment or profile is shown to readers as `https://go.pyqdeck.in/{code}`.

- The author's text is stored as typed and links are substituted when content is returned (authors get `rawBody` for
  editing). Each link is checked: only `http/https`, no credentials, no private or loopback addresses, shorteners
  refused, at most 5 per post and 3 per comment, domain block lists (per community and platform-wide).
- A tap on a **clean** link redirects at once. A **suspicious**, **unchecked** or **lookalike** (punycode) link shows a
  warning page with Continue; a **blocked** or **malicious** one is refused (403); a link whose post is gone answers 410.
- Reputation uses a replaceable provider chain. Today it has local heuristics only; add a free feed or Google Web Risk
  by implementing `LinkReputationProvider` in `modules/links/link.reputation.ts` and adding it in `links.module.ts`.

**Hosting** (works on one Render service, including the free plan's two included custom domains):

1. Add both custom domains to the same service: `community-api.pyqdeck.in` and `go.pyqdeck.in`. Point each DNS record
   (`CNAME`) at the service as Render instructs.
2. Set `LINK_HOST=go.pyqdeck.in`, `TRUST_PROXY=1` and leave `SERVE_MODE=all`. The app picks the router from the `Host`
   header: the link host serves only redirects, and the API host serves no short links.
3. Later, to split them: run one instance with `SERVE_MODE=api` and another with `SERVE_MODE=links`. No code change.
4. Make sure the Expo app's Android intent filters and iOS associated domains do not claim `go.pyqdeck.in`.

A free Render instance sleeps after 15 minutes idle (about a minute to wake), which makes the first short-link tap
slow. Use an always-on instance when you launch.

## The SDK and the Expo app

`sdk/` is the TypeScript client (`@pyqdeck/community-sdk`). It has no Clerk, React or cache inside: the app passes a
`getToken()` function and owns caching (TanStack Query) and retries.

```ts
const community = createCommunityClient({ baseUrl: "https://community-api.pyqdeck.in", community: "beu", getToken });
const post = await community.publishPost({ body, images, onProgress, signal }); // upload, check and publish in one call
const feed = await community.posts.feed({ hashtag: "dsa" }); // { items, nextCursor, hasMore }
queryClient.invalidateQueries({ queryKey: communityKeys.feeds("beu") }); // keys always include the community
```

Errors are `CommunityApiError` with `status`, a stable `code`, `retryAfterMs` and `requestId`. Build with
`pnpm exec tsc -p sdk/tsconfig.json`.

The Expo app (`../pyqdeck-expo`) depends on it with `"@pyqdeck/community-sdk": "file:../pyqdeck-community/sdk"` and talks
to this server through `src/community/*` (client, store, mappers). After changing the SDK, rebuild it and run
`pnpm install` in the app. The app's server address is `EXPO_PUBLIC_COMMUNITY_API_URL` (defaults to
`https://community-api.pyqdeck.in`; use `http://10.0.2.2:5000` for a local server from the Android emulator). Publish
the SDK to a registry before building the app in the cloud (EAS), because `file:` only resolves on your machine.

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
   POST /api/v1/admin/storage/accounts
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
`GET /api/v1/admin/storage/accounts` to see usage, `PATCH` to disable or reprioritise, and
`POST /api/v1/admin/storage/accounts/:id/refresh-usage` to re-sync real usage from the provider.

### How the app uploads (direct, no bytes through this server)

1. `POST /api/v1/communities/{community}/media/uploads` with `{ "files": [{ "mimeType": "image/png", "size": 123456 }] }` (up to 8). The response
   has one ticket per file: `{ id, upload: { method, url, fields, fileField, expiresAt } }`.
2. Send a multipart `POST` to `upload.url` containing every key of `upload.fields` plus the file in the field named
   `upload.fileField`. This goes straight to the provider.
3. `POST /api/v1/communities/{community}/media/:id/complete`. The server asks the provider what actually arrived and rejects (and deletes) anything
   larger than declared or not a JPEG/PNG/WebP. The media is then `pending` until a post uses it; unused uploads are
   removed automatically after about an hour.

`POST .../media` (multipart, field `files`) still exists as a fallback that passes bytes through this server.

### Adding another provider later (e.g. UploadThing, R2)

Write `src/modules/storage/providers/<name>.provider.ts` implementing `StorageProvider` (plus `DirectUploadProvider`
for direct uploads) and register it in `providers/index.ts`. Nothing else changes. Details are in `AGENTS.md`.

## Content moderation

Everything users submit is checked by the OpenAI Moderation API (`omni-moderation-latest`, free to use) before it can be
published. Images are already covered; posts and comments will use the same service.

**A free word filter runs first.** Before any text goes to OpenAI it is checked locally against the
[`bad-words`](https://www.npmjs.com/package/bad-words) list plus a short list of Hindi abuse written in English letters. A
hit is refused at once with a plain message ("Your text contains language that is not allowed here..."), the OpenAI API
is **not called**, and the images that came with that text are not sent either. It sees through simple tricks
(`sh1t`, `f*ck`, `fuuuck`, `f u c k`, hidden characters), ignores links, and matches whole words, so "class" and
"Scunthorpe" are fine. Words that are normal in a study community (`sex ratio`, `dyke` in civil engineering, `screw`,
`rectum`, `hell`, `damn`, `god` ...) are allowed by default. Tune it with `PROFANITY_EXTRA_WORDS`,
`PROFANITY_ALLOWED_WORDS` (comma separated, lower case) or switch it off with `PROFANITY_FILTER=false`. The refusal is
recorded (who, where, "profanity") without storing the words. It is a first pass, not a replacement for the AI check.

**What happens to bad content**

| Situation                                                                                         | Result                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Sexual content, hate, graphic violence, threats, etc.                                             | **Rejected** (`422`), image deleted, event logged                      |
| Borderline: harassment, violence, self-harm, drug content, or a high score just under the cut-off | **Held** (images are rejected until a review queue exists)             |
| Moderation service down, slow, or key invalid                                                     | **Never published**: `503 try again shortly` (images stay `uploading`) |
| Image the checker cannot read (corrupt, unsupported)                                              | Rejected                                                               |
| Sexual content involving minors                                                                   | Rejected **and flagged `escalate`** (see below)                        |

Where the images are checked: multipart uploads are checked **before** being stored (a rejected image never reaches the
storage provider); direct uploads are checked at `POST .../media/:id/complete`, and a rejected file is deleted from
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

- **Clerk owns the login** (one Clerk instance for every PYQDeck app). This server never issues tokens or stores passwords.
- **An account** is the private, global record of a Clerk user (id, email, platform role). It is never returned by any endpoint.
- **A membership** is the public persona in one community: handle, display name, avatar, headline, bio, links, skills,
  academic attributes, counters, `role` (`member` / `moderator` / `admin`) and `status`. It is created on the first
  request in that community, prefilled from Clerk, and edited independently afterwards (`PATCH .../members/me`).
- **Reserved names:** Clerk can't block usernames, so a Clerk username such as `admin` or `support` is not adopted as a
  handle; one is generated from the email. A username never proves staff status. Only `role` does.
- **Deleting a Clerk account** scrubs every membership (name, avatar, bio; the handle is freed), hides all its posts and
  comments immediately and purges them after 30 days. Authors render as "Deleted user".
- **Admin bootstrap:** list your email in `COMMUNITY_ADMIN_EMAILS`, sign in once, and you're a platform admin (and `admin`
  in each community you enter). Only verified emails count, and promotion is one-way.

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
├── modules/    one folder per feature: accounts, communities, members, posts, comments, links, media, ...
├── docs/       OpenAPI assembly + Swagger UI
├── composition.ts  wires modules together through small ports (core/ports)
├── routes/     mounts everything under /api and /api/v1
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
- [ ] Both domains (`community-api.pyqdeck.in`, `go.pyqdeck.in`) are on the service; `LINK_HOST` and `TRUST_PROXY=1` are set
- [ ] Only communities that are ready are active (no `jee` / `neet` before the legal review)
- [ ] Rate limits are per process: with more than one instance, move the counters to a shared store first
- [ ] Reverse proxy forwards the **raw** body on `/api/webhooks/clerk` (do not rewrite or re-encode it, or signature
      checks fail)
