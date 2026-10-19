# AGENTS.md

Express 5 + TypeScript (ESM) + Mongoose + Zod backend for PYQDeck community.

## Commands

- `pnpm dev` – run with tsx watch
- `pnpm typecheck` – `tsc --noEmit` (run after every change)
- `pnpm build` / `pnpm start` – compile to `dist/` and run

## Layout

```
src/
├── config/        env.ts (zod-validated env, import `env` – never read process.env elsewhere), database.ts
├── core/          shared, feature-agnostic code
│   ├── base/        BaseRepository, BaseService, BaseController
│   ├── errors/      AppError
│   ├── middleware/  validate, errorHandler, notFound
│   └── utils/       response.ts (sendSuccess)
├── modules/<feature>/   one folder per feature
├── docs/          openapi.ts (spec assembly), swagger.ts (UI router)
├── routes/index.ts      mounts each module router under /api/<feature>
├── app.ts               builds the express app (no listen)
└── server.ts            connects DB, listens, graceful shutdown
```

## Layered pattern (request flow)

`routes -> validate middleware -> controller -> service -> repository -> model`

Each layer only calls the one below it.

| Layer      | File                | Responsibility                                                                                                                              |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Model      | `<f>.model.ts`      | Mongoose schema + `I<Name>` interface                                                                                                       |
| Repository | `<f>.repository.ts` | Only place that touches the model. `extends BaseRepository<I<Name>>`, passes model to `super`. Add custom queries here (e.g. `findByCode`). |
| Service    | `<f>.service.ts`    | Business rules. `extends BaseService<I, Repo>`, `super(repo, "Name")`. Throw `AppError` for failures. Override base methods to add rules.   |
| Controller | `<f>.controller.ts` | HTTP only. `extends BaseController<I, Service>`. Handlers are arrow-function properties so they can be passed to the router unbound.        |
| Schema     | `<f>.schema.ts`     | Zod schemas for body/params/query (list query = `paginationQuerySchema.extend({...filters})`)                                               |
| Docs       | `<f>.docs.ts`       | OpenAPI `paths` for the module, registered in `src/docs/openapi.ts`                                                                         |
| Routes     | `<f>.routes.ts`     | Creates `Router`, instantiates controller, wires `validate({...})` + handlers, `export default router`                                      |

Dependencies are injected via constructor default params (`constructor(repo = new XRepository())`) so tests can pass fakes.

## Adding a feature

1. Create `src/modules/<feature>/` with the files above (skip model/repository if no persistence, as in `health`).
2. Register in `src/routes/index.ts`: `router.use("/<feature>", featureRoutes)`.
3. Run `pnpm typecheck`.

## Conventions

- Local imports use the `.js` extension (NodeNext ESM), e.g. `import x from "./x.js"`.
- Files are named `<feature>.<layer>.ts`; classes are PascalCase (`SubjectService`).
- Never put business logic in controllers or DB calls in services.
- Errors: throw `AppError.notFound()/badRequest()/conflict()/...`; Express 5 forwards async errors automatically, so no try/catch or asyncHandler. `errorHandler` formats the response.
- HTTP status: always use `StatusCodes` from `http-status-codes` (never numeric literals). `AppError` takes a `StatusCodes` value and defaults its message to `getReasonPhrase`.
- Responses (`core/utils/response.ts`): `sendSuccess(res, data, status?)` -> `{ success: true, data }`; `sendPaginated(res, items, pagination)` -> `{ success: true, data, pagination }`; `sendNoContent(res)` -> 204. Errors -> `{ success: false, message, details? }`. 5xx messages are hidden in production.
- Pagination (`core/utils/pagination.ts`): list endpoints validate query with `paginationQuerySchema` (`page`, `limit` max 100, `sort` like `-createdAt,name`); extra query keys become the Mongo filter in `BaseController.list`. `BaseRepository.paginate` returns `{ items, pagination: { total, page, limit, totalPages, hasNext, hasPrev } }`. Whitelist filter keys in the feature's query schema – do not pass raw user input as a filter.
- Validation: `validate({ body, params, query })`. Express 5 `req.query` is read-only, so parsed query is in `res.locals.query`.
- Mongoose types: this Mongoose version uses `QueryFilter` (not `FilterQuery`).
- Env vars: add to the zod schema in `config/env.ts` and to `.env.example`.

## Logging & request IDs

- Use `logger` from `core/utils/logger.ts` (pino) – never `console.*` (only `config/env.ts` may, since logger depends on env). Inside a request use `req.log` so the request id is attached automatically.
- `requestLogger` (pino-http) gives every request `req.id`, honours a sane incoming `x-request-id`, echoes it in the response header, and logs at info/warn/error by status. `/api/health` is not logged. Error responses include `requestId`.
- `LOG_LEVEL` env controls verbosity; dev output is pretty-printed.

## Compression

`compression()` is applied globally in `app.ts`.

## API docs (Swagger)

- Served at `/api/docs` (UI) and `/api/docs/json` (spec), disabled when `NODE_ENV=production`. Mounted before `helmet` because swagger-ui needs inline scripts.
- Each module documents itself in `<feature>.docs.ts` exporting an OpenAPI `paths` object; register it in `src/docs/openapi.ts`. Shared components exist: `Pagination` and `Error` schemas, `Page`/`Limit`/`Sort` parameters (reference with `$ref: "#/components/parameters/Page"` etc.).
- Update the module's docs whenever its routes or schemas change.

## Package manager

This project uses **pnpm** (never npm/yarn; no `package-lock.json`). Build scripts are allow-listed in `package.json` under `pnpm.onlyBuiltDependencies`.

## Testing

- Vitest + Supertest + mongodb-memory-server. `pnpm test`, `pnpm test:watch`, `pnpm test:coverage`.
- `tests/unit` for pure logic; `tests/integration` for HTTP through the real middleware stack via `createApp(testRoutes)`.
- `tests/globalSetup.ts` starts one in-memory MongoDB for the run (first run downloads the mongod binary). Each test file uses its own database via `tests/helpers/db.ts` (`connectTestDb`, `clearTestDb`, `disconnectTestDb`).
- `tests/helpers/widget.ts` is a throwaway module following the layered pattern, used to exercise the base classes. Copy its approach when testing a new feature.
- `tsconfig.json` covers src + tests (typecheck); `tsconfig.build.json` builds only `src` to `dist`.

## Auth (Clerk), accounts and memberships

- Identity is **Clerk, same instance as the main PYQDeck server**. This server never issues tokens or stores passwords. Data is NOT shared with the main server: separate database.
- Two records, never mixed up: **`Account`** (global, private: `clerkId`, `email`, `platformRole`) and **`Member`** (per community, public persona: handle, name, avatar, bio ..., `role`, `status`). The same person has an unlinked Member in each community. Never expose `email`, `clerkId` or `accountId`.
- Flow: `clerkAuth` (Bearer token) -> `attachAccount` (`req.account`, created on first sight) -> on community routes `createResolveCommunity` (`req.community`, from the PATH only) -> `attachMember` (`req.member`, created on the first request there) -> route guards.
- Anonymous-friendly: the middlewares fail soft. **Protection is per route**: `requireAuth` (401 signed out/deleted, 403 suspended; a temporary suspension lapses on its own), `requireRole("moderator")` (community admins pass), `requirePlatformAdmin` (communities, storage). Never read `req.member` on a route without `requireAuth`.
- Handles: Clerk cannot block usernames, so reserved ones (`admin`, `support` ...) are never adopted; a handle is generated from the email instead. A username never proves staff status; `role` does.
- Admin bootstrap: verified Clerk emails in `COMMUNITY_ADMIN_EMAILS` become platform admins (promote-only) and `admin` in each community they enter.
- Webhook `POST /api/webhooks/clerk` (raw body, Svix-signed): `user.created/updated` refresh the account snapshot (the prefill for NEW memberships; existing personas are untouched); `user.deleted` scrubs the account and every membership and runs the account-deleted listeners registered in `composition.ts` (posts and comments are soft-deleted and purged after 30 days).
- Tests mock `@clerk/express` (session = `x-test-user` header); see `tests/helpers/clerk.ts`.

## Communities, tenancy and wiring

- **Every community-scoped record has a `communityId`** and repositories for them extend `ScopedRepository` (`createIn`, `findOneIn`, `findIn`, `updateOneIn` ... take the community first). Never use the inherited unscoped finders on such a collection. The community comes from the path `/api/v1/communities/:community`, never from the body or a header (NFR-ISO-3). A new community-scoped endpoint needs a cross-community leak test (see `tests/integration/social.test.ts`).
- **`src/composition.ts` is the composition root** for the community features. Modules depend on small ports in `core/ports` (`ContentModerator`, `MediaAttachments`, `LinkRewriter`, `Notifier`) or on interfaces they declare (`PostAccess` in comments); only the composition root and the `*.module.ts` files know the concrete services.
- **Status changes go through a state machine.** Each entity with a status has a table (`*.states.ts` or next to its model) built with `defineMachine` from `core/state`; `docs/STATE-MACHINES.md` is the plan. Change status with ONE guarded atomic update (`findOneAndUpdate({ _id, status: { $in: machine.allowedFrom(to) } })`); a null result means 404/409. Side effects (counters, links, media, notifications) follow the transition and must be idempotent. Add a row to the table test in `tests/unit/core-primitives.test.ts` when adding a state.
- **Visibility is decided in one place per read path** (feed, detail, comments, profiles): published only, plus the author's own held content; deleted/suspended authors and blocked pairs (both ways) are excluded; "not yours" and "does not exist" both answer 404.
- **Pagination:** feeds, comments, notifications and member lists use cursor pages (`core/utils/cursor.ts`, `sendCursorPage`); the older offset helper remains for admin lists.
- **Rate limits:** `rateLimit({ limit, windowMs })` (in memory, per process, scaled by `RATE_LIMIT_SCALE`); 429 carries `Retry-After`.
- **Idempotency:** `Idempotency-Key` on creating posts and comments (`modules/idempotency`).
- **Links:** user text is stored as typed; `LinkRewriter.render` substitutes `go.pyqdeck.in` short links when returning content. Every new place that stores user text with URLs must call `links.sync` (it throws a 422 for unsafe URLs) and `links.setLive` when the content changes state. The link host is selected by `Host` in `app.ts` (`SERVE_MODE`, `LINK_HOST`).
- **SDK:** `sdk/` mirrors the API for the apps. Change the SDK in the same commit as an API change; `tests/integration/sdk.test.ts` runs it against the real server.
- Tests for community features: `tests/helpers/client.ts` (`client(app)(clerkId, community)`), `community.ts` (`seedCommunity`, `setMemberRole`) and `fake-moderation.ts` (steer verdicts with the words REJECTME / HOLDME / DOWNME).

## Storage and media (files)

Two modules with a strict one-way dependency: `media` uses `storage` through a port; `storage` knows nothing about media.

- **`modules/storage`** stores bytes across any number of provider accounts. Contracts live in `storage.types.ts`: `StorageProvider` (`upload`, `delete`, `ping`, optional `getUsage`), the optional `DirectUploadProvider` capability (`createUploadTicket`, `inspect`), `AccountStore` and `ProviderResolver`. `StorageService` depends only on those two ports.
- **Providers are plug-ins.** Add one by writing `providers/<name>.provider.ts` that exports a `ProviderDescriptor` (type, zod credentials schema, factory) and adding one `.register(...)` line in `providers/index.ts`. Never branch on a provider name anywhere else. `memory` is dev/test only and is not registered in production. Currently: `cloudinary`, `memory`.
- **Accounts are data, not config.** They live in the `storage_accounts` collection with encrypted credentials (AES-256-GCM, key `STORAGE_ENCRYPTION_KEY`) and are managed via the platform-admin-only `/api/v1/admin/storage/*` endpoints. Adding a new account needs no redeploy. Credentials must never be returned or logged.
- **Capacity.** `AccountStore.reserveSpace` reserves bytes atomically (one `findOneAndUpdate`), fills accounts by `priority` then age, and keeps `STORAGE_HEADROOM_PERCENT` free. On `QuotaExceededError` the account is marked `full` and the upload fails over. Always release a reservation when a file is not kept.
- **`modules/media`** owns `Media` records (`uploading` -> `pending` -> `attached`). Posts must reference media by id, never by raw URL. It defines its own ports (`FileStorage`, `DirectUploadStorage`, `FileValidator`); wiring happens only in `media.module.ts` / `storage.module.ts` (the composition roots).
- **Two ways to upload.** Preferred: direct from the app. `POST /api/v1/communities/:community/media/uploads` (declare type+size) returns signed tickets, the app sends the bytes straight to the provider, then `POST /api/v1/communities/:community/media/:id/complete` makes the server ask the provider what arrived (size and type are verified, mismatches are deleted). Fallback: `POST .../media` multipart passes the bytes through the server.
- **For content modules:** call `MediaService.attach(communityId, ownerId, ids)` (returns the URLs) when content is created and `MediaService.release(ids)` when it is deleted or an image is removed. Unclaimed uploads are removed by `MediaCleanupJob` (`pending` after 1h, `uploading` after 65 min).
- **Limits:** 8 images per post, 8 MB each, JPEG/PNG/WebP, at most 16 unfinished tickets per user. File type is decided from the bytes (multipart) or by the provider (direct), never from the filename or client `Content-Type`.
- Tests: unit tests (`pnpm test:unit`) need no database and cover the storage logic with `tests/helpers/fake-accounts.ts`; integration tests use the `memory` provider and its `simulateClientUpload` helper to act as the app.

## Moderation (all user-generated content)

- **Every piece of user content must go through `getModerationService().moderate(input, context)` before it is published**: post text, comments, captions, and images. Do not call OpenAI directly from a feature, and do not skip it "for now".
- `moderate()` returns `{ action: "allow" | "review" | "reject", categories, reasons, degraded, escalate }` and never throws because the provider is down. Handle it like this: `allow` -> publish; `review` -> do NOT publish (store as `pending_review`, or reject if there is no queue); `reject` -> `AppError.unprocessable(...)` (422). `degraded: true` means the checker was unavailable: treat as `review` for text, or answer 503 for flows the client can retry. **Fail closed: unchecked content is never published.**
- **Word filter first:** `ModerationService` asks `ProfanityCheck` (`profanity.ts`, built on the `bad-words` list) before the provider; a hit returns `reject` with category `profanity` and the provider is never called. Feature code needs nothing: it already maps `reject` to 422, and `refusalMessage()` (`core/ports/content-moderator.ts`) turns the `profanity` category into a fixable message. Tune with `PROFANITY_*` env vars; the default allow-list lives in `DEFAULT_ALLOWED_WORDS`.
- Layers: `ModerationProvider` (vendor, `providers/openai.provider.ts`) -> `ModerationPolicy` (pure rules, `DEFAULT_POLICY` table) -> `ModerationService` (orchestration, fail-closed, audit) -> `ModerationAudit` (`ModerationEventRepository`). The vendor is chosen in one place, `moderation.module.ts`. To change rules edit `DEFAULT_POLICY`; to change vendor write a new provider.
- Other modules depend on a small port they define themselves, not on the moderation module (see `ImageModerator` in `media.types.ts`, adapted in `media.module.ts`). Do the same for posts/comments.
- `context` is audit-only (`userId`, `source` such as "post" or "comment", `sourceId`). Pass them; never send user identity to the provider.
- **Never store or log the moderated content.** `ModerationEvent` keeps who/what/why/scores only, with a 90 day TTL. Every result is kept, **allowed ones included** (`action: allow`), with the checked thing's id in `sourceId` (a media id for images), so "what did the check say about this image?" is `GET .../moderation/events?sourceId=<id>` (moderators). `escalate: true` (sexual/minors) is logged at error level and needs a human/legal process.
- Images: moderate raw bytes before storing when they pass through the server, or by URL at the `complete` step for direct uploads. A rejected stored file must be deleted; a moderation outage must NOT delete it (the client retries).
- Without `OPENAI_API_KEY`, development uses a passthrough provider that allows everything and logs a warning. Production refuses to start without the key (`REQUIRED_IN_PRODUCTION` in `config/env.ts`).
- Tests: `tests/unit/moderation-*.test.ts` need no network (fake `fetch`/provider). For feature tests inject a fake moderator, as `tests/integration/media-moderation.test.ts` does.
