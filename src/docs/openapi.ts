import { moderationPaths } from "../modules/moderation/moderation.docs.js";
import { mediaPaths } from "../modules/media/media.docs.js";
import { storagePaths } from "../modules/storage/storage.docs.js";
import { userPaths } from "../modules/users/user.docs.js";
import { healthPaths } from "../modules/health/health.docs.js";

/** Register each module's `<feature>.docs.ts` paths here. */
const paths = {
  ...healthPaths,
  ...userPaths,
  ...mediaPaths,
  ...moderationPaths,
  ...storagePaths,
};

export const openApiSpec = {
  openapi: "3.0.3",
  info: { title: "PYQDeck Community API", version: "1.0.0" },
  servers: [{ url: "/api" }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Clerk session token (same Clerk instance as the main PYQDeck app)",
      },
    },
    parameters: {
      Page: { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
      Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      Sort: {
        name: "sort",
        in: "query",
        description: "Comma separated fields, `-` prefix for descending",
        schema: { type: "string", default: "-createdAt", example: "-createdAt,name" },
      },
    },
    schemas: {
      Pagination: {
        type: "object",
        properties: {
          total: { type: "integer" },
          page: { type: "integer" },
          limit: { type: "integer" },
          totalPages: { type: "integer" },
          hasNext: { type: "boolean" },
          hasPrev: { type: "boolean" },
        },
      },
      Error: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          message: { type: "string" },
          details: {},
          requestId: { type: "string", format: "uuid" },
        },
      },
    },
  },
};
