import { defineMachine } from "../../core/state/state-machine.js";

export const MEMBER_ROLES = ["member", "moderator", "admin"] as const;
export const MEMBER_STATUSES = ["active", "suspended", "deleted"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** `deleted` is entered once per membership when the Clerk account is deleted and never left. */
export const memberMachine = defineMachine<MemberStatus>("Member", {
  active: ["suspended", "deleted"],
  suspended: ["active", "deleted"],
  deleted: [],
});
