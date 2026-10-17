import type { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { sendSuccess } from "../../core/utils/response.js";
import type { StorageAdminService } from "./storage-admin.service.js";

export class StorageAdminController {
  constructor(private readonly service: StorageAdminService) {}

  providers = (_req: Request, res: Response) => {
    sendSuccess(res, this.service.providerTypes());
  };

  list = async (_req: Request, res: Response) => {
    sendSuccess(res, await this.service.list());
  };

  add = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.add(req.body), StatusCodes.CREATED);
  };

  update = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.update(String(req.params.id), req.body));
  };

  refreshUsage = async (req: Request, res: Response) => {
    sendSuccess(res, await this.service.refreshUsage(String(req.params.id)));
  };
}
