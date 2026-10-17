export const healthPaths = {
  "/health": {
    get: {
      tags: ["Health"],
      summary: "Service and database health",
      responses: {
        "200": {
          description: "Service is up",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["ok", "degraded"] },
                      uptime: { type: "number", description: "Seconds" },
                      timestamp: { type: "string", format: "date-time" },
                      database: { type: "string", enum: ["connected", "disconnected"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
