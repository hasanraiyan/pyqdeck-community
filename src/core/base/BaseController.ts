import type { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { paginationQuerySchema } from "../utils/pagination.js";
import { sendNoContent, sendPaginated, sendSuccess } from "../utils/response.js";
import type { BaseService } from "./BaseService.js";

/** HTTP layer. Controllers translate requests to service calls and responses. */
export abstract class BaseController<T, S extends BaseService<T> = BaseService<T>> {
  constructor(protected readonly service: S) {}

  create = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.create(req.body), StatusCodes.CREATED);
  };

  /** Expects `validate({ query })` with a schema extending `paginationQuerySchema`; extra keys become the filter. */
  list = async (req: Request, res: Response) => {
    const { page, limit, sort, ...filter } = res.locals.query ?? paginationQuerySchema.parse(req.query);
    const { items, pagination } = await this.service.list(filter, { page, limit, sort });
    sendPaginated(res, items, pagination);
  };

  getById = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.getById(String(req.params.id)));
  };

  update = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.update(String(req.params.id), req.body));
  };

  delete = async (req: Request, res: Response) => {
    await this.service.delete(String(req.params.id));
    sendNoContent(res);
  };
}
