import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/utils/logger.js";
import { profileInputShape, type ProfileTool } from "./mcp.profile.js";

/** The Clerk user id that authorized the call. `mcpAuthClerk` puts Clerk's OAuth auth object in `authInfo`. */
const clerkIdOf = (authInfo: unknown): string | undefined => {
  const userId = (authInfo as { userId?: unknown } | undefined)?.userId;
  return typeof userId === "string" && userId ? userId : undefined;
};

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError && { isError: true }),
});

/** A fresh server per request (stateless HTTP), exposing the one tool. */
export function createMcpServer(tool: ProfileTool) {
  const server = new McpServer({ name: "pyqdeck-community", version: "1.0.0" });

  server.registerTool(
    "manage_profile",
    {
      title: "Manage my PYQDeck Community profile",
      description:
        "Read and edit your own PYQDeck Community profile, or look up other members. Actions: read, search, patch " +
        "(change only the fields you send), update (replace the whole editable profile), clear (empty named fields). " +
        "Your profile is created automatically the first time you sign in and cannot be deleted here.",
      inputSchema: profileInputShape,
    },
    async (args, { authInfo }) => {
      try {
        return text(await tool.run(clerkIdOf(authInfo), args));
      } catch (err) {
        // Messages of AppError are written for people; anything else must not leak internals.
        if (err instanceof AppError && err.statusCode < 500) return text(err.message, true);
        logger.error({ err }, "manage_profile failed");
        return text("Something went wrong, please try again", true);
      }
    },
  );

  return server;
}
