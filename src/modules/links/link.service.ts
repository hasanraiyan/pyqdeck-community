import type { Types } from "mongoose";
import { AppError } from "../../core/errors/AppError.js";
import type {
  LinkContentType,
  LinkRef,
  LinkRewriter,
  RenderedContent,
  SyncLinksInput,
} from "../../core/ports/link-rewriter.js";
import { logger } from "../../core/utils/logger.js";
import { decideClick, type ClickDecision } from "./link.decision.js";
import type { ILink } from "./link.model.js";
import type { ReputationChain } from "./link.reputation.js";
import type { BlockedDomainRepository, LinkRepository } from "./link.repository.js";
import {
  REJECTION_MESSAGES,
  UrlRejected,
  extractUrls,
  findForbiddenScheme,
  hostMatches,
  isLookalikeHost,
  normalizeUrl,
  type NormalizedUrl,
} from "./url-tools.js";

export interface LinkConfig {
  /** Hostname that serves short links, e.g. go.pyqdeck.in. */
  host: string;
  codeLength: number;
  recheckMs: number;
  /** URLs on these domains are the product's own: shown as typed, never wrapped (FR-LNK-2). */
  ownDomains: string[];
  /** Bound on a click-time re-check so a slow feed cannot hold up a redirect. */
  recheckTimeoutMs: number;
}

export const DEFAULT_LINK_CONFIG: Omit<LinkConfig, "host" | "codeLength" | "recheckMs"> = {
  ownDomains: ["pyqdeck.in"],
  recheckTimeoutMs: 1500,
};

/** Shorteners hide the destination, so they are refused at launch (TBD-25). Moderators extend this list at runtime. */
export const DEFAULT_BLOCKED_DOMAINS = [
  "bit.ly",
  "tinyurl.com",
  "goo.gl",
  "is.gd",
  "ow.ly",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "tiny.cc",
  "rb.gy",
];

const keyOf = (contentType: string, contentId: string) => `${contentType}:${contentId}`;

type LinkDoc = ILink & { _id: Types.ObjectId };

export class LinkService implements LinkRewriter {
  constructor(
    private readonly links: LinkRepository,
    private readonly blocked: BlockedDomainRepository,
    private readonly reputation: ReputationChain,
    private readonly config: LinkConfig,
  ) {}

  shortUrl = (code: string) => `https://${this.config.host}/${code}`;

  stripUrls(text: string): string {
    const spans = extractUrls(text);
    let out = "";
    let cursor = 0;
    for (const s of spans) {
      out += text.slice(cursor, s.start) + " ";
      cursor = s.end;
    }
    return out + text.slice(cursor);
  }

  /** Validated, de-duplicated external URLs of some texts, in order of appearance. Throws 422 on the first bad one. */
  private collect(texts: string[]): NormalizedUrl[] {
    const found = new Map<string, NormalizedUrl>();
    for (const text of texts) {
      const scheme = findForbiddenScheme(text);
      if (scheme) throw AppError.unprocessable(`Links using "${scheme}:" are not allowed`);
      for (const span of extractUrls(text)) {
        let url: NormalizedUrl;
        try {
          url = normalizeUrl(span.raw);
        } catch (err) {
          if (err instanceof UrlRejected) throw AppError.unprocessable(REJECTION_MESSAGES[err.reason]);
          throw err;
        }
        if (this.isOwn(url.host)) continue;
        found.set(url.href, url);
      }
    }
    return [...found.values()];
  }

  private isOwn(host: string) {
    return [this.config.host, ...this.config.ownDomains].some((d) => hostMatches(host, d));
  }

  async sync(input: SyncLinksInput): Promise<void> {
    const urls = this.collect(input.texts);
    if (urls.length > input.maxLinks) {
      throw AppError.unprocessable(`At most ${input.maxLinks} different links are allowed here`);
    }

    // Everything is vetted before anything is written, so a refused URL leaves no half-created links.
    const vetted: Array<{ url: NormalizedUrl; verdict: ILink["verdict"]; source: string }> = [];
    for (const url of urls) {
      if (this.isStaticallyBlocked(url.host) || (await this.blocked.isBlocked(url.host, input.communityId))) {
        throw AppError.unprocessable(`Links to ${url.host} are not allowed here`);
      }
      const result = await this.reputation.check(url.href, url.host);
      if (result.verdict === "malicious") throw AppError.unprocessable(`The link to ${url.host} was flagged as unsafe`);
      vetted.push({ url, verdict: result.verdict, source: result.source });
    }

    const status = input.live ? "active" : "inactive";
    for (const { url, verdict, source } of vetted) {
      const link = await this.links.upsertForContent(
        input.communityId,
        { contentType: input.contentType, contentId: input.contentId, normalizedUrl: url.href },
        { host: url.host, createdBy: input.authorId, length: this.config.codeLength },
      );
      await this.links.setVerdict(link.code, verdict, source);
      await this.links.transition(
        input.communityId,
        { code: link.code },
        status === "active" ? ["inactive"] : ["active"],
        status,
      );
    }
    // URLs the author removed in an edit stop redirecting, though the old codes are never reused (FR-LNK-7, 20).
    await this.links.deactivateExcept(
      input.communityId,
      input.contentType,
      input.contentId,
      vetted.map((v) => v.url.href),
    );
  }

  async setLive(contentType: LinkContentType, contentIds: string[], live: boolean): Promise<void> {
    if (contentIds.length === 0) return;
    // Links are community scoped, but content ids are globally unique ObjectIds, so one update covers the batch.
    await this.links.setLiveForContents(contentType, contentIds, live);
  }

  async render(
    items: Array<{ contentType: LinkContentType; contentId: string; text: string }>,
  ): Promise<Map<string, RenderedContent>> {
    const out = new Map<string, RenderedContent>();
    const wanted = items.filter((i) => i.text.includes("http"));
    for (const i of items) out.set(keyOf(i.contentType, i.contentId), { text: i.text, links: [] });
    if (wanted.length === 0) return out;

    const rows = await this.links.findForContentIds(wanted.map((i) => i.contentId));
    const byPair = new Map(rows.map((l) => [`${keyOf(l.contentType, l.contentId)}|${l.normalizedUrl}`, l]));

    for (const item of wanted) {
      const key = keyOf(item.contentType, item.contentId);
      const spans = extractUrls(item.text);
      let text = item.text;
      const links = new Map<string, LinkRef & { clicks: number }>();
      for (const span of [...spans].reverse()) {
        let href: string;
        try {
          href = normalizeUrl(span.raw).href;
        } catch {
          continue;
        }
        const link = byPair.get(`${key}|${href}`);
        if (!link) continue;
        text = text.slice(0, span.start) + this.shortUrl(link.code) + text.slice(span.end);
        links.set(link.code, {
          code: link.code,
          shortUrl: this.shortUrl(link.code),
          host: link.host,
          clicks: link.clicks,
        });
      }
      out.set(key, { text, links: [...links.values()].reverse() });
    }
    return out;
  }

  /** Looks the code up and decides what a click does. A destination is only ever read from the stored link. */
  async resolveClick(code: string, confirmed = false): Promise<{ decision: ClickDecision; link?: LinkDoc }> {
    const link = await this.links.findByCode(code);
    if (!link) return { decision: { kind: "notfound" } };

    let verdict = link.verdict;
    let recheckFailed = false;
    const stale = !link.checkedAt || Date.now() - link.checkedAt.getTime() > this.config.recheckMs;
    if (stale && link.status !== "inactive" && verdict !== "malicious") {
      try {
        const fresh = await withTimeout(
          this.reputation.check(link.normalizedUrl, link.host),
          this.config.recheckTimeoutMs,
        );
        verdict = fresh.verdict;
        await this.links.setVerdict(link.code, fresh.verdict, fresh.source);
      } catch (err) {
        logger.warn({ code, err: (err as Error).message }, "click-time re-check failed");
        recheckFailed = true;
      }
    }

    const domainBlocked =
      this.isStaticallyBlocked(link.host) || (await this.blocked.isBlocked(link.host, link.communityId));
    const decision = decideClick(
      {
        exists: true,
        status: link.status,
        verdict,
        domainBlocked,
        lookalike: isLookalikeHost(link.host),
        recheckFailed,
      },
      confirmed,
    );
    return { decision, link };
  }

  recordClick(code: string) {
    return this.links.countClick(code).catch((err) => logger.warn({ err }, "failed to count a click"));
  }

  async describe(code: string) {
    const { decision, link } = await this.resolveClick(code);
    if (!link) throw AppError.notFound("Link not found");
    return { code: link.code, host: link.host, verdict: link.verdict, status: link.status, decision: decision.kind };
  }

  /** True when the code belongs to a link of this community (used to validate reports). */
  async existsInCommunity(communityId: Types.ObjectId, code: string) {
    const link = await this.links.findByCode(code);
    return Boolean(link && link.communityId.equals(communityId));
  }

  /** The destination host of a link of this community, for the moderator's report list. */
  async hostOf(communityId: Types.ObjectId, code: string): Promise<string | null> {
    const link = await this.links.findByCode(code);
    return link && link.communityId.equals(communityId) ? link.host : null;
  }

  // ---- moderation ----

  async blockLink(communityId: Types.ObjectId, code: string) {
    const link = await this.links.findByCode(code);
    if (!link || !link.communityId.equals(communityId)) throw AppError.notFound("Link not found");
    await this.links.transition(communityId, { code }, ["active", "inactive"], "blocked");
  }

  async unblockLink(communityId: Types.ObjectId, code: string) {
    const link = await this.links.findByCode(code);
    if (!link || !link.communityId.equals(communityId)) throw AppError.notFound("Link not found");
    await this.links.transition(communityId, { code }, ["blocked"], "inactive");
  }

  listBlockedDomains(scope: string) {
    return this.blocked.list(scope);
  }

  blockDomain(scope: string, domain: string, reason: string, createdBy?: Types.ObjectId) {
    return this.blocked.add({ scope, domain: domain.toLowerCase(), reason, createdBy });
  }

  unblockDomain(scope: string, domain: string) {
    return this.blocked.remove(scope, domain);
  }

  private isStaticallyBlocked(host: string) {
    return DEFAULT_BLOCKED_DOMAINS.some((d) => hostMatches(host, d));
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
