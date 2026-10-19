/** Replaces only the text-moderation port, so tests can steer verdicts with marker words in the content. */
export const withFakeModerator = <T extends object>(real: T) => ({
  ...real,
  getContentModerator: () => ({
    moderateText: async (text: string) => {
      if (text.includes("REJECTME")) return { action: "reject" as const, degraded: false, categories: ["hate"] };
      if (text.includes("HOLDME")) return { action: "review" as const, degraded: false, categories: ["harassment"] };
      if (text.includes("DOWNME")) return { action: "review" as const, degraded: true, categories: [] };
      return { action: "allow" as const, degraded: false, categories: [] };
    },
  }),
});
