# AGENTS.md

Express 5 + TypeScript (ESM) + Mongoose + Zod backend for PYQDeck community.

## Commands

- `npm run dev` – run with tsx watch
- `npm run typecheck` – `tsc --noEmit` (run after every change)
- `npm run build` / `npm start` – compile to `dist/` and run

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
3. Run `npm run typecheck`.

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
