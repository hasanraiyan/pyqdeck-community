import type { QueryFilter, UpdateQuery } from "mongoose";
import { AppError } from "../errors/AppError.js";
import type { PaginationQuery } from "../utils/pagination.js";
import type { BaseRepository } from "./BaseRepository.js";

/** Business-logic layer. Services use repositories, never models directly. */
export abstract class BaseService<T, R extends BaseRepository<T> = BaseRepository<T>> {
  constructor(
    protected readonly repository: R,
    protected readonly resourceName: string,
  ) {}

  create(data: Partial<T>) {
    return this.repository.create(data);
  }

  list(filter: QueryFilter<T>, pagination: PaginationQuery) {
    return this.repository.paginate(filter, pagination);
  }

  async getById(id: string) {
    const doc = await this.repository.findById(id);
    if (!doc) throw AppError.notFound(`${this.resourceName} not found`);
    return doc;
  }

  async update(id: string, data: UpdateQuery<T>) {
    const doc = await this.repository.updateById(id, data);
    if (!doc) throw AppError.notFound(`${this.resourceName} not found`);
    return doc;
  }

  async delete(id: string) {
    const doc = await this.repository.deleteById(id);
    if (!doc) throw AppError.notFound(`${this.resourceName} not found`);
  }
}
