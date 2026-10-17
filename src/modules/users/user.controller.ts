import type { Request, Response } from "express";
import { AppError } from "../../core/errors/AppError.js";
import { sendSuccess } from "../../core/utils/response.js";
import { toOwnProfile, toPublicProfile } from "./user.dto.js";
import { UserService } from "./user.service.js";

export class UserController {
  constructor(private readonly service = new UserService()) {}

  /** Routes using this sit behind `requireAuth`, so a missing user here is a wiring bug, not a client error. */
  private currentUser(req: Request) {
    if (!req.user) throw AppError.unauthorized();
    return req.user;
  }

  me = (req: Request, res: Response) => {
    sendSuccess(res, toOwnProfile(this.currentUser(req)));
  };

  updateMe = async (req: Request, res: Response) => {
    const updated = await this.service.updateProfile(this.currentUser(req), req.body);
    sendSuccess(res, toOwnProfile(updated));
  };

  getByUsername = async (req: Request, res: Response) => {
    sendSuccess(res, toPublicProfile(await this.service.getByUsername(String(req.params.username))));
  };
}
