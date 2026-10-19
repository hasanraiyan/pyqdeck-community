import compression from "compression";
import cors from "cors";
import express, { type Router } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import swaggerRouter from "./docs/swagger.js";
import { errorHandler, notFound } from "./core/middleware/errorHandler.js";
import { attachAccount } from "./modules/auth/auth.middleware.js";
import { createLinkHostRoutes } from "./modules/links/link.routes.js";
import clerkWebhookRoutes from "./modules/auth/clerk-webhook.routes.js";
import { clerkAuth } from "./modules/auth/clerk.middleware.js";
import { requestLogger } from "./core/middleware/requestLogger.js";
import { createMcpRouter } from "./composition.js";
import defaultRoutes from "./routes/index.js";

/** `apiRoutes` is injectable so tests can mount extra routers on the real middleware stack. */
export function createApp(apiRoutes: Router = defaultRoutes) {
  const app = express();
  // Behind Render or another proxy, req.ip and req.hostname must be the client values (rate limits, link host).
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(requestLogger);
  app.use(compression());

  // Mounted before helmet: swagger-ui needs inline scripts that helmet's default CSP blocks.
  if (env.NODE_ENV !== "production") app.use("/api/docs", swaggerRouter);

  app.use(helmet());

  // Short links are served from their own hostname by this same process (or alone, in `links` mode). Nothing but
  // redirects is reachable there (IR-API-13).
  if (env.SERVE_MODE !== "api") {
    const linkHost = createLinkHostRoutes();
    app.use((req, res, next) =>
      env.SERVE_MODE === "links" || req.hostname === env.LINK_HOST ? linkHost(req, res, next) : next(),
    );
    if (env.SERVE_MODE === "links") return app;
  }

  app.use(cors({ origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",") }));
  // Svix signs the raw bytes, so the webhook must be mounted before express.json().
  app.use("/api/webhooks", clerkWebhookRoutes);

  app.use(express.json());
  app.use(clerkAuth);
  app.use(attachAccount);

  // At the root, not under /api: the OAuth discovery paths are fixed by the MCP and OAuth specs.
  app.use(createMcpRouter());
  app.use("/api", apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
