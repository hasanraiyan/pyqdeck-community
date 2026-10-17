import type { HydratedDocument } from "mongoose";
import type { IUser } from "../modules/users/user.model.js";

declare global {
  namespace Express {
    interface Request {
      /** Community profile of the signed-in caller; set by `attachUser`. */
      user?: HydratedDocument<IUser>;
    }
  }
}
