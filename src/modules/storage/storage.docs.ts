const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const account = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string", example: "cloudinary-1" },
    provider: { type: "string", example: "cloudinary" },
    status: { type: "string", enum: ["active", "full", "disabled"] },
    priority: { type: "integer", description: "Lower is filled first" },
    capacityBytes: { type: "integer" },
    usedBytes: { type: "integer" },
    usedPercent: { type: "number" },
    lastSyncedAt: { type: "string", format: "date-time" },
  },
};

const ok = (schema: object) => ({
  description: "OK",
  content: {
    "application/json": {
      schema: { type: "object", properties: { success: { type: "boolean", example: true }, data: schema } },
    },
  },
});

const admin = { tags: ["Storage (admin)"], security: [{ bearerAuth: [] }] };
const id = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];

export const storagePaths = {
  "/admin/storage/providers": {
    get: {
      ...admin,
      summary: "Supported provider types",
      responses: { "200": ok({ type: "array", items: { type: "string" } }) },
    },
  },
  "/admin/storage/accounts": {
    get: {
      ...admin,
      summary: "List storage accounts with usage",
      responses: { "200": ok({ type: "array", items: account }), "403": err("Admin only") },
    },
    post: {
      ...admin,
      summary: "Plug in a new storage account",
      description:
        'Credentials are validated against the provider and tested before saving, then stored encrypted. For Cloudinary: `{"cloudName","apiKey","apiSecret"}`.',
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name", "provider", "credentials", "capacityBytes"],
              properties: {
                name: { type: "string", example: "cloudinary-2" },
                provider: { type: "string", example: "cloudinary" },
                credentials: { type: "object", additionalProperties: true },
                capacityBytes: { type: "integer", example: 2147483648 },
                priority: { type: "integer", example: 100 },
              },
            },
          },
        },
      },
      responses: {
        "201": ok(account),
        "400": err("Unknown provider, bad credentials, or connection test failed"),
        "403": err("Admin only"),
        "409": err("Name already used"),
      },
    },
  },
  "/admin/storage/accounts/{id}": {
    patch: {
      ...admin,
      summary: "Rename, reprioritise, resize, or enable/disable an account",
      parameters: id,
      responses: { "200": ok(account), "404": err("Not found") },
    },
  },
  "/admin/storage/accounts/{id}/refresh-usage": {
    post: {
      ...admin,
      summary: "Sync real usage from the provider; re-opens a full account that has room",
      parameters: id,
      responses: { "200": ok(account), "404": err("Not found") },
    },
  },
};
