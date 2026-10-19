import { Router, type RequestHandler, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { sendNoContent, sendSuccess } from "../../core/utils/response.js";
import { requireAuth, requirePlatformAdmin, requireRole } from "../auth/auth.middleware.js";
import { PAGE_CSP, blockedPage, gonePage, notFoundPage, warningPage } from "./link.pages.js";
import { getLinkService } from "./links.module.js";
import type { LinkService } from "./link.service.js";

const BOT_AGENT = /bot|crawler|spider|preview|facebookexternalhit|slackbot|whatsapp|telegram|discord|curl|wget/i;
const codeParam = z.object({ code: z.string().regex(/^[A-Za-z0-9]{8,16}$/) });

/** Every response from the link host: never cached (takedowns apply at once) and never indexed (FR-LNK-24). */
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
};

const page = (res: Response, status: StatusCodes, html: string) => {
  res.status(status).setHeader("Content-Security-Policy", PAGE_CSP).type("html").send(html);
};

/**
 * The link host (`go.pyqdeck.in`). Exposes redirects only, never the JSON API (IR-API-13). The destination always
 * comes from the stored link, never from the request, so it cannot be used as an open redirect (FR-LNK-16).
 */
export function createLinkHostRoutes(service: LinkService = getLinkService()) {
  const router = Router();
  router.use(noStore, rateLimit({ limit: 240, windowMs: 60_000, key: (req) => `link:${req.ip}` }));

  const respond = async (code: string, confirmed: boolean, userAgent: string, res: Response) => {
    const { decision, link } = await service.resolveClick(code, confirmed);
    switch (decision.kind) {
      case "notfound":
        return page(res, StatusCodes.NOT_FOUND, notFoundPage());
      case "gone":
        return page(res, StatusCodes.GONE, gonePage());
      case "blocked":
        return page(res, StatusCodes.FORBIDDEN, blockedPage());
      case "warn":
        return page(res, StatusCodes.OK, warningPage({ host: link!.host, code, reason: decision.reason }));
      case "redirect":
        if (!BOT_AGENT.test(userAgent)) void service.recordClick(code);
        return res.redirect(StatusCodes.MOVED_TEMPORARILY, link!.normalizedUrl);
    }
  };

  router.get("/:code", validate({ params: codeParam }), (req, res) =>
    respond(String(req.params.code), false, req.get("user-agent") ?? "", res),
  );
  // The Continue button on the warning page: overrides warnings, never blocks.
  router.get("/:code/go", validate({ params: codeParam }), (req, res) =>
    respond(String(req.params.code), true, req.get("user-agent") ?? "", res),
  );
  router.use((_req, res) => page(res, StatusCodes.NOT_FOUND, notFoundPage()));
  return router;
}

const domainBody = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/),
  reason: z.string().max(300).default(""),
});

/** Community routes: let the app check a link (IR-SDK-13) and let moderators block links and domains (FR-LNK-21). */
export function createLinkApiRoutes(service: LinkService = getLinkService()) {
  const router = Router({ mergeParams: true });

  router.get("/:code", validate({ params: codeParam }), async (req, res) => {
    sendSuccess(res, await service.describe(String(req.params.code)));
  });

  const staff = [requireAuth, requireRole("moderator")];
  router.post("/:code/block", ...staff, validate({ params: codeParam }), async (req, res) => {
    await service.blockLink(req.community!._id, String(req.params.code));
    sendNoContent(res);
  });
  router.delete("/:code/block", ...staff, validate({ params: codeParam }), async (req, res) => {
    await service.unblockLink(req.community!._id, String(req.params.code));
    sendNoContent(res);
  });
  router.get("/blocked-domains/list", ...staff, async (req, res) => {
    const rows = await service.listBlockedDomains(req.community!.id);
    sendSuccess(
      res,
      rows.map((r) => ({ domain: r.domain, reason: r.reason, createdAt: r.createdAt })),
    );
  });
  router.post("/blocked-domains/list", ...staff, validate({ body: domainBody }), async (req, res) => {
    await service.blockDomain(req.community!.id, req.body.domain, req.body.reason, req.member!._id);
    sendSuccess(res, { domain: req.body.domain }, StatusCodes.CREATED);
  });
  router.delete("/blocked-domains/list/:domain", ...staff, async (req, res) => {
    await service.unblockDomain(req.community!.id, String(req.params.domain));
    sendNoContent(res);
  });
  return router;
}

/** Platform-wide domain block list: platform admins only. */
export function createPlatformLinkRoutes(service: LinkService = getLinkService()) {
  const router = Router();
  router.use(requirePlatformAdmin);
  router.get("/", async (_req, res) => {
    sendSuccess(
      res,
      (await service.listBlockedDomains("platform")).map((r) => ({ domain: r.domain, reason: r.reason })),
    );
  });
  router.post("/", validate({ body: domainBody }), async (req, res) => {
    await service.blockDomain("platform", req.body.domain, req.body.reason);
    sendSuccess(res, { domain: req.body.domain }, StatusCodes.CREATED);
  });
  router.delete("/:domain", async (req, res) => {
    await service.unblockDomain("platform", String(req.params.domain));
    sendNoContent(res);
  });
  return router;
}
