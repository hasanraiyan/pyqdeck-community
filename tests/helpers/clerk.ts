/**
 * Stand-in for @clerk/express. The "session" is an x-test-user header carrying the Clerk user id.
 * Use in a test file with:
 *   vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);
 */
export interface FakeClerkUser {
  email: string;
  verified: boolean;
  name: string;
  username: string | null;
}

export const clerkUsers = new Map<string, FakeClerkUser>();

export const addClerkUser = (id: string, u: Partial<FakeClerkUser> & { email: string }) =>
  clerkUsers.set(id, { verified: true, name: "Test User", username: null, ...u });

export const as = (clerkId: string) => ({ "x-test-user": clerkId });

export const clerkModule = {
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: (req: { headers: Record<string, string | undefined> }) => ({ userId: req.headers["x-test-user"] ?? null }),
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        const u = clerkUsers.get(id);
        if (!u) throw new Error("not found");
        return {
          primaryEmailAddress: {
            emailAddress: u.email,
            verification: { status: u.verified ? "verified" : "unverified" },
          },
          fullName: u.name,
          username: u.username,
          imageUrl: "https://img.test/a.png",
        };
      },
    },
  },
};
