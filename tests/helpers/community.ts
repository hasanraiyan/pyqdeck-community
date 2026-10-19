/** Helpers for tests that run inside a community. Models are imported lazily so vi.mock of Clerk applies first. */
export const BASE = (slug = "beu") => `/api/v1/communities/${slug}`;

export async function seedCommunity(slug = "beu", over: Record<string, unknown> = {}) {
  const { CommunityModel } = await import("../../src/modules/communities/community.model.js");
  return CommunityModel.create({ slug, name: slug.toUpperCase(), ...over });
}

export async function communityIdOf(slug = "beu") {
  const { CommunityModel } = await import("../../src/modules/communities/community.model.js");
  return (await CommunityModel.findOne({ slug }))!.id as string;
}

/** Sets a member's role directly, the way an admin would have, for tests that need a moderator. */
export async function setMemberRole(clerkId: string, role: "member" | "moderator" | "admin", slug = "beu") {
  const [{ AccountModel }, { MemberModel }, { CommunityModel }] = await Promise.all([
    import("../../src/modules/accounts/account.model.js"),
    import("../../src/modules/members/member.model.js"),
    import("../../src/modules/communities/community.model.js"),
  ]);
  const account = await AccountModel.findOne({ clerkId });
  const community = await CommunityModel.findOne({ slug });
  await MemberModel.updateOne({ accountId: account!._id, communityId: community!._id }, { role });
}
