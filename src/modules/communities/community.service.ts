import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/utils/logger.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import type { CommunityLimits, ICommunity } from "./community.model.js";
import { CommunityRepository } from "./community.repository.js";
import { communityMachine, type CommunityStatus } from "./community.states.js";

export interface CreateCommunityInput {
  slug: string;
  name: string;
  limits?: Partial<CommunityLimits>;
}

export class CommunityService {
  constructor(private readonly repository = new CommunityRepository()) {}

  async create(input: CreateCommunityInput) {
    try {
      return await this.repository.create({ ...input, slug: input.slug.toLowerCase() });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw AppError.conflict("A community with this slug already exists");
      throw err;
    }
  }

  list() {
    return this.repository.find({});
  }

  async getBySlug(slug: string) {
    const community = await this.repository.findBySlug(slug);
    if (!community) throw AppError.notFound("Community not found");
    return community;
  }

  async update(slug: string, patch: Partial<Pick<ICommunity, "name" | "limits" | "profileSchema">>) {
    const updated = await this.repository.update(slug, patch);
    if (!updated) throw AppError.notFound("Community not found");
    return updated;
  }

  async setStatus(slug: string, to: CommunityStatus) {
    const current = await this.getBySlug(slug);
    communityMachine.assertTransition(current.status, to);
    const moved = await this.repository.transition(current.slug, communityMachine.allowedFrom(to), to);
    if (!moved) throw AppError.conflict("The community changed, please retry");
    return moved;
  }

  /** Creates the communities named in config if they do not exist yet. Safe to run on every boot. */
  async ensureDefaults(slugs: string[]) {
    for (const slug of slugs) {
      if (await this.repository.findBySlug(slug)) continue;
      try {
        await this.create({ slug, name: slug.toUpperCase() });
        logger.info({ slug }, "created default community");
      } catch (err) {
        if (!(err instanceof AppError)) throw err; // lost a race with another instance: fine
      }
    }
  }
}
