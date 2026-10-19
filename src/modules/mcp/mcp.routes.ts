import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { authServerMetadataHandlerClerk, mcpAuthClerk, protectedResourceHandlerClerk } from "@clerk/mcp-tools/express";
import type { ProfileTool } from "./mcp.profile.js";
import { createMcpServer } from "./mcp.server.js";

/**
 * Remote MCP endpoint. Clerk is the OAuth server: clients discover it from the two `.well-known` documents, sign the
 * person in, and send the access token to `POST /mcp`, where `mcpAuthClerk` verifies it and sets `req.auth`.
 * Mounted at the site root (not under /api) because the well-known paths are fixed by the specs.
 *
 * Stateless: every request gets its own server and transport, so there is no session to lose on a restart or to share
 * between instances.
 */
export function createMcpRoutes(tool: ProfileTool) {
  const router = Router();
  const resource = protectedResourceHandlerClerk({ scopes_supported: ["profile", "email"] });

  const handle: RequestHandler = async (req, res) => {
    const server = createMcpServer(tool);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  // Stateless servers have no stream to open and no session to end.
  const notAllowed: RequestHandler = (_req, res) => {
    res
      .status(StatusCodes.METHOD_NOT_ALLOWED)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
  };

  router.get("/.well-known/oauth-protected-resource", resource);
  router.get("/.well-known/oauth-protected-resource/mcp", resource);
  router.get("/.well-known/oauth-authorization-server", authServerMetadataHandlerClerk);
  router.post("/mcp", mcpAuthClerk, handle);
  router.get("/mcp", notAllowed);
  router.delete("/mcp", notAllowed);
  return router;
}
