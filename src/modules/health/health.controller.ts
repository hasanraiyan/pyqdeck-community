import type { Request, Response } from "express";
import { sendSuccess } from "../../core/utils/response.js";
import { HealthService } from "./health.service.js";

export class HealthController {
  constructor(private readonly service = new HealthService()) {}

  check = (_req: Request, res: Response) => {
    sendSuccess(res, this.service.check());
  };
}
