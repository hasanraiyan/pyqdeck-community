import type { Request, Response } from "express";
import type { HydratedDocument } from "mongoose";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../../core/errors/AppError.js";
import { sendNoContent, sendSuccess } from "../../core/utils/response.js";
import type { IMedia } from "./media.model.js";
import type { MediaService } from "./media.service.js";

/** Public shape of a media record. Storage internals (account, key, provider) stay private. */
export const toMediaDto = (m: HydratedDocument<IMedia>) => ({
  id: m.id as string,
  url: m.url,
  mimeType: m.mimeType,
  size: m.size,
  status: m.status,
  createdAt: m.createdAt,
});

export class MediaController {
  constructor(private readonly service: MediaService) {}

  upload = async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();
    const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({
      buffer: f.buffer,
      originalName: f.originalname,
    }));
    const media = await this.service.upload(user.id, files);
    sendSuccess(res, media.map(toMediaDto), StatusCodes.CREATED);
  };

  requestUploads = async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();
    const items = await this.service.requestUploads(user.id, req.body.files);
    sendSuccess(
      res,
      items.map(({ media, ticket }) => ({ id: media.id as string, upload: ticket })),
      StatusCodes.CREATED,
    );
  };

  complete = async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();
    sendSuccess(res, toMediaDto(await this.service.complete(user.id, String(req.params.id))));
  };

  remove = async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();
    await this.service.delete({ id: user.id, role: user.role }, String(req.params.id));
    sendNoContent(res);
  };
}
