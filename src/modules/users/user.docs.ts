const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const publicProfile = {
  type: "object",
  properties: {
    username: { type: "string", example: "raiyan_01" },
    displayName: { type: "string" },
    avatarUrl: { type: "string" },
    headline: { type: "string" },
    bio: { type: "string" },
    role: { type: "string", enum: ["member", "moderator", "admin"] },
    createdAt: { type: "string", format: "date-time" },
  },
};

const ownProfile = {
  allOf: [
    publicProfile,
    {
      type: "object",
      properties: {
        id: { type: "string" },
        email: { type: "string", format: "email" },
        status: { type: "string", enum: ["active", "suspended", "deleted"] },
      },
    },
  ],
};

const ok = (schema: object) => ({
  description: "OK",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { success: { type: "boolean", example: true }, data: schema },
      },
    },
  },
});

export const userPaths = {
  "/users/me": {
    get: {
      tags: ["Users"],
      summary: "Current user's profile (created on first call)",
      security: [{ bearerAuth: [] }],
      responses: { "200": ok(ownProfile), "401": err("Not signed in"), "403": err("Account suspended") },
    },
    patch: {
      tags: ["Users"],
      summary: "Update own profile (headline and bio only; username, name and avatar come from Clerk)",
      security: [{ bearerAuth: [] }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                headline: { type: "string", maxLength: 120 },
                bio: { type: "string", maxLength: 500 },
              },
            },
          },
        },
      },
      responses: {
        "200": ok(ownProfile),
        "400": err("Validation failed"),
        "401": err("Not signed in"),
      },
    },
  },
  "/users/{username}": {
    get: {
      tags: ["Users"],
      summary: "Public profile",
      parameters: [{ name: "username", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": ok(publicProfile), "404": err("Not found") },
    },
  },
};
