import { CommunityService } from "./community.service.js";

let service: CommunityService | undefined;
export const getCommunityService = () => (service ??= new CommunityService());
