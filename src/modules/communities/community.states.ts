import { defineMachine } from "../../core/state/state-machine.js";

export const COMMUNITY_STATUSES = ["active", "read_only", "disabled"] as const;
export type CommunityStatus = (typeof COMMUNITY_STATUSES)[number];

export const communityMachine = defineMachine<CommunityStatus>("Community", {
  active: ["read_only", "disabled"],
  read_only: ["active", "disabled"],
  disabled: ["active"],
});
