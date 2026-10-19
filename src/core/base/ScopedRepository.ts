import type { HydratedDocument, QueryFilter, Types, UpdateQuery } from "mongoose";
import { BaseRepository } from "./BaseRepository.js";

type Id = string | Types.ObjectId;

/**
 * Data access for community-scoped records (NFR-ISO-1). Every method takes the community first and merges it into
 * the filter, so a feature built on this class cannot read or change another community's data by forgetting a
 * condition. Prefer these methods over the unscoped ones inherited from `BaseRepository`.
 */
export abstract class ScopedRepository<T extends { communityId: Types.ObjectId }> extends BaseRepository<T> {
  protected scope(communityId: Id, filter: QueryFilter<T> = {}): QueryFilter<T> {
    return { ...filter, communityId } as QueryFilter<T>;
  }

  createIn(communityId: Id, data: Omit<Partial<T>, "communityId">): Promise<HydratedDocument<T>> {
    return this.model.create({ ...data, communityId } as never) as Promise<HydratedDocument<T>>;
  }

  findByIdIn(communityId: Id, id: Id) {
    return this.model.findOne(this.scope(communityId, { _id: id } as QueryFilter<T>)).exec();
  }

  findOneIn(communityId: Id, filter: QueryFilter<T>) {
    return this.model.findOne(this.scope(communityId, filter)).exec();
  }

  findIn(communityId: Id, filter: QueryFilter<T> = {}) {
    return this.model.find(this.scope(communityId, filter));
  }

  countIn(communityId: Id, filter: QueryFilter<T> = {}) {
    return this.model.countDocuments(this.scope(communityId, filter)).exec();
  }

  existsIn(communityId: Id, filter: QueryFilter<T>) {
    return this.model.exists(this.scope(communityId, filter)).exec();
  }

  /** Applies `update` to one matching record and returns the new version, or null if nothing matched. */
  updateOneIn(communityId: Id, filter: QueryFilter<T>, update: UpdateQuery<T>) {
    return this.model
      .findOneAndUpdate(this.scope(communityId, filter), update, { returnDocument: "after", runValidators: true })
      .exec();
  }

  async updateManyIn(communityId: Id, filter: QueryFilter<T>, update: UpdateQuery<T>): Promise<number> {
    const result = await this.model.updateMany(this.scope(communityId, filter), update).exec();
    return result.modifiedCount;
  }

  async deleteManyIn(communityId: Id, filter: QueryFilter<T>): Promise<number> {
    const result = await this.model.deleteMany(this.scope(communityId, filter)).exec();
    return result.deletedCount;
  }
}
