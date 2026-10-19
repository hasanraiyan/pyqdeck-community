import { randomInt } from "node:crypto";
import type { Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import {
  BlockedDomainModel,
  LinkClickDailyModel,
  LinkModel,
  linkMachine,
  type IBlockedDomain,
  type ILink,
  type LinkStatus,
  type LinkVerdict,
} from "./link.model.js";

type Id = string | Types.ObjectId;
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters

export const generateCode = (length: number) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

export class LinkRepository extends ScopedRepository<ILink> {
  constructor() {
    super(LinkModel);
  }

  /** Public redirect lookup: by code only, never by anything the request supplies about the destination. */
  findByCode(code: string) {
    return this.model.findOne({ code }).exec();
  }

  findForContents(communityId: Id, contentType: string, contentIds: string[]) {
    return this.findIn(communityId, { contentType, contentId: { $in: contentIds } } as never).exec();
  }

  findForContentIds(contentIds: string[]) {
    return this.model.find({ contentId: { $in: contentIds } }).exec();
  }

  /** Content follows its links: published content activates them, anything else deactivates them. Blocked stays blocked. */
  async setLiveForContents(contentType: string, contentIds: string[], live: boolean) {
    const [from, to]: [LinkStatus[], LinkStatus] = live ? [["inactive"], "active"] : [["active"], "inactive"];
    const result = await this.model
      .updateMany({ contentType, contentId: { $in: contentIds }, status: { $in: from } } as never, { status: to })
      .exec();
    return result.modifiedCount;
  }

  /** Finds the pair's link or creates it with a fresh unique code. The code never changes for an unchanged URL. */
  async upsertForContent(
    communityId: Id,
    key: { contentType: ILink["contentType"]; contentId: string; normalizedUrl: string },
    fields: { host: string; createdBy: Id; length: number },
  ): Promise<ILink & { _id: Types.ObjectId }> {
    const existing = await this.findOneIn(communityId, key as never);
    if (existing) return existing;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.createIn(communityId, {
          ...key,
          host: fields.host,
          createdBy: fields.createdBy as never,
          code: generateCode(fields.length),
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const raced = await this.findOneIn(communityId, key as never);
        if (raced) return raced; // another request created the same pair
        // otherwise the random code collided: try another
      }
    }
    throw new Error("could not allocate a link code");
  }

  setVerdict(code: string, verdict: LinkVerdict, source: string) {
    return this.model.updateOne({ code }, { verdict, verdictSource: source, checkedAt: new Date() }).exec();
  }

  /** Guarded status change: applies only to links currently in one of `from`, and only along edges of `linkMachine`. */
  async transition(communityId: Id, filter: Record<string, unknown>, from: LinkStatus[], to: LinkStatus) {
    const allowed = from.filter((f) => linkMachine.canTransition(f, to));
    const result = await this.model
      .updateMany({ ...filter, communityId, status: { $in: allowed } }, { status: to })
      .exec();
    return result.modifiedCount;
  }

  deactivateExcept(communityId: Id, contentType: string, contentId: string, keepUrls: string[]) {
    return this.transition(
      communityId,
      { contentType, contentId, normalizedUrl: { $nin: keepUrls } },
      ["active"],
      "inactive",
    );
  }

  async countClick(code: string) {
    const day = new Date().toISOString().slice(0, 10);
    await Promise.all([
      this.model.updateOne({ code }, { $inc: { clicks: 1 } }).exec(),
      LinkClickDailyModel.updateOne({ code, day }, { $inc: { count: 1 } }, { upsert: true }).exec(),
    ]);
  }

  clicksPerDay(code: string) {
    return LinkClickDailyModel.find({ code }).sort({ day: -1 }).limit(30).lean().exec();
  }
}

export class BlockedDomainRepository {
  /** Is `host` (or a parent domain of it) blocked platform-wide or in this community? */
  async isBlocked(host: string, communityId: Id): Promise<boolean> {
    const parents = host
      .split(".")
      .map((_, i, parts) => parts.slice(i).join("."))
      .filter((d) => d.includes("."));
    return (
      (await BlockedDomainModel.exists({
        domain: { $in: parents },
        scope: { $in: ["platform", communityId.toString()] },
      }).exec()) !== null
    );
  }

  list(scope: string) {
    return BlockedDomainModel.find({ scope }).sort({ domain: 1 }).exec();
  }

  async add(entry: Pick<IBlockedDomain, "scope" | "domain" | "reason" | "createdBy">) {
    try {
      return await BlockedDomainModel.create(entry);
    } catch (err) {
      if (isDuplicateKeyError(err))
        return BlockedDomainModel.findOne({ scope: entry.scope, domain: entry.domain }).exec();
      throw err;
    }
  }

  async remove(scope: string, domain: string) {
    return (await BlockedDomainModel.deleteOne({ scope, domain: domain.toLowerCase() }).exec()).deletedCount > 0;
  }
}
