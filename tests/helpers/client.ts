import request from "supertest";
import type { Test } from "supertest";
import { as } from "./clerk.js";
import { BASE } from "./community.js";

type App = Parameters<typeof request>[0];

/** `client(app)(clerkId?, community?)` gives get/post/put/patch/del helpers rooted at that community. */
export const client =
  (app: App) =>
  (clerkId?: string, slug = "beu") => {
    const base = BASE(slug);
    const wrap = (r: Test) => (clerkId ? r.set(as(clerkId)) : r);
    return {
      get: (path: string) => wrap(request(app).get(base + path)),
      post: (path: string, body?: object) =>
        wrap(
          request(app)
            .post(base + path)
            .send(body ?? {}),
        ),
      put: (path: string, body?: object) =>
        wrap(
          request(app)
            .put(base + path)
            .send(body ?? {}),
        ),
      patch: (path: string, body?: object) =>
        wrap(
          request(app)
            .patch(base + path)
            .send(body ?? {}),
        ),
      del: (path: string) => wrap(request(app).delete(base + path)),
    };
  };
