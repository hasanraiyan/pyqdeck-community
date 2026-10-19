const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

export const moderationPaths = {
  "/moderation/events": {
    get: {
      tags: ["Moderation"],
      summary: "Blocked or held content, newest first (moderators and admins)",
      description:
        "Each event records what was blocked and why. The content itself is never stored. Events are deleted after 90 days.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/Page" },
        { $ref: "#/components/parameters/Limit" },
        { $ref: "#/components/parameters/Sort" },
        { name: "action", in: "query", schema: { type: "string", enum: ["allow", "review", "reject"] } },
        { name: "source", in: "query", schema: { type: "string", example: "media" } },
        { name: "escalate", in: "query", description: "Only child-safety escalations", schema: { type: "boolean" } },
        { name: "userId", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "A page of events",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        userId: { type: "string" },
                        source: { type: "string" },
                        sourceId: { type: "string" },
                        action: { type: "string", enum: ["allow", "review", "reject"] },
                        degraded: { type: "boolean" },
                        escalate: { type: "boolean" },
                        categories: { type: "array", items: { type: "string" } },
                        scores: { type: "object", additionalProperties: { type: "number" } },
                        provider: { type: "string" },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        "401": err("Not signed in"),
        "403": err("Moderators and admins only"),
      },
    },
  },
};
