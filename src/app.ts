import compression from "compression";
import cors from "cors";
import express, { type Router } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import swaggerRouter from "./docs/swagger.js";
import { errorHandler, notFound } from "./core/middleware/errorHandler.js";
import { attachUser } from "./modules/auth/auth.middleware.js";
import clerkWebhookRoutes from "./modules/auth/clerk-webhook.routes.js";
import { clerkAuth } from "./modules/auth/clerk.middleware.js";
import { requestLogger } from "./core/middleware/requestLogger.js";
import defaultRoutes from "./routes/index.js";

/** `apiRoutes` is injectable so tests can mount extra routers on the real middleware stack. */
export function createApp(apiRoutes: Router = defaultRoutes) {
  const app = express();

  app.use(requestLogger);
  app.use(compression());

  // Mounted before helmet: swagger-ui needs inline scripts that helmet's default CSP blocks.
  if (env.NODE_ENV !== "production") app.use("/api/docs", swaggerRouter);

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",") }));
  // Svix signs the raw bytes, so the webhook must be mounted before express.json().
  app.use("/api/webhooks", clerkWebhookRoutes);

  app.use(express.json());
  app.use(clerkAuth);
  app.use(attachUser);

  app.use("/api", apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
