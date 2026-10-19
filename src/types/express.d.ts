import type { HydratedDocument } from "mongoose";
import type { IAccount } from "../modules/accounts/account.model.js";
import type { ICommunity } from "../modules/communities/community.model.js";
import type { IMember } from "../modules/members/member.model.js";

declare global {
  namespace Express {
    interface Request {
      /** The signed-in person (global, one per Clerk user); set by `attachAccount`. */
      account?: HydratedDocument<IAccount>;
      /** The community named in the path; set by `resolveCommunity` on community-scoped routes. */
      community?: HydratedDocument<ICommunity>;
      /** The caller's membership in `req.community`; set by `attachMember` when signed in. */
      member?: HydratedDocument<IMember>;
    }
  }
}
