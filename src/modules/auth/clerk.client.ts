import { clerkClient } from "@clerk/express";

/** What the community needs to know about a Clerk account. */
export interface ClerkProfile {
  clerkId: string;
  email: string;
  emailVerified: boolean;
  /** Clerk username; null when the Clerk instance does not collect usernames or the user has none. */
  username: string | null;
  displayName: string;
  avatarUrl: string;
}

export type FetchClerkProfile = (clerkId: string) => Promise<ClerkProfile | null>;

/** Reads the profile from Clerk itself; nothing client-supplied is trusted. Returns null if the account has no email. */
export const fetchClerkProfile: FetchClerkProfile = async (clerkId) => {
  const user = await clerkClient.users.getUser(clerkId);
  const primary = user.primaryEmailAddress;
  if (!primary?.emailAddress) return null;

  const email = primary.emailAddress.toLowerCase();
  return {
    clerkId,
    email,
    username: user.username ? user.username.toLowerCase() : null,
    emailVerified: primary.verification?.status === "verified",
    displayName: (
      user.fullName ||
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.username ||
      email.split("@")[0]
    ).slice(0, 80),
    avatarUrl: user.imageUrl ?? "",
  };
};
