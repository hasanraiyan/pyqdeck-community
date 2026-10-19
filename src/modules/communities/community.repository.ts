import { BaseRepository } from "../../core/base/BaseRepository.js";
import { CommunityModel, type ICommunity } from "./community.model.js";

export class CommunityRepository extends BaseRepository<ICommunity> {
  constructor() {
    super(CommunityModel);
  }

  findBySlug(slug: string) {
    return this.findOne({ slug: slug.toLowerCase() });
  }

  update(slug: string, patch: Partial<ICommunity>) {
    return this.model
      .findOneAndUpdate({ slug: slug.toLowerCase() } as never, patch, { returnDocument: "after", runValidators: true })
      .exec();
  }

  /** Guarded status change: matches only while the community is still in one of the `from` states. */
  transition(slug: string, from: string[], to: string) {
    return this.model
      .findOneAndUpdate({ slug, status: { $in: from } } as never, { status: to }, { returnDocument: "after" })
      .exec();
  }
}
