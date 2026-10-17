import type { HydratedDocument, Model, QueryFilter, UpdateQuery } from "mongoose";
import { buildPageMeta, toMongoSort, type PageMeta, type PaginationQuery } from "../utils/pagination.js";

export interface Page<T> {
  items: T[];
  pagination: PageMeta;
}

/** Data-access layer. Only repositories talk to Mongoose models. */
export abstract class BaseRepository<T> {
  constructor(protected readonly model: Model<T>) {}

  create(data: Partial<T>): Promise<HydratedDocument<T>> {
    return this.model.create(data);
  }

  findById(id: string) {
    return this.model.findById(id).exec();
  }

  findOne(filter: QueryFilter<T>) {
    return this.model.findOne(filter).exec();
  }

  find(filter: QueryFilter<T> = {}) {
    return this.model.find(filter).exec();
  }

  async paginate(filter: QueryFilter<T>, { page, limit, sort }: PaginationQuery): Promise<Page<HydratedDocument<T>>> {
    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(toMongoSort(sort))
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return { items, pagination: buildPageMeta(total, page, limit) };
  }

  updateById(id: string, update: UpdateQuery<T>) {
    return this.model.findByIdAndUpdate(id, update, { new: true, runValidators: true }).exec();
  }

  deleteById(id: string) {
    return this.model.findByIdAndDelete(id).exec();
  }

  exists(filter: QueryFilter<T>) {
    return this.model.exists(filter).exec();
  }
}
