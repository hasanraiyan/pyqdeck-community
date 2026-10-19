import { getContentModerator } from "../moderation/moderation.module.js";
import { getLinkService } from "../links/links.module.js";
import { getMediaService } from "../media/media.module.js";
import { MemberRepository } from "./member.repository.js";
import { MemberService } from "./member.service.js";

/** Composition root for members: moderation, media and links come in as ports. */
let service: MemberService | undefined;
export const getMemberService = () =>
  (service ??= new MemberService(new MemberRepository(), getContentModerator(), getMediaService(), getLinkService()));
