const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const mediaItem = {
  type: "object",
  properties: {
    id: { type: "string" },
    url: { type: "string", format: "uri" },
    mimeType: { type: "string", example: "image/webp" },
    size: { type: "integer", description: "Bytes" },
    status: { type: "string", enum: ["uploading", "pending", "attached"] },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const mediaPaths = {
  "/media/uploads": {
    post: {
      tags: ["Media"],
      summary: "Start direct uploads (preferred): get signed tickets to upload straight to storage",
      description:
        "Declare the type and size of up to 8 images. For each, the response holds a ticket: send a multipart POST to `upload.url` with every key in `upload.fields` plus the file in the field named `upload.fileField`. Then call `POST /media/{id}/complete`. Bytes never pass through this API.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["files"],
              properties: {
                files: {
                  type: "array",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    required: ["mimeType", "size"],
                    properties: {
                      mimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
                      size: { type: "integer", minimum: 1, maximum: 8388608, description: "Bytes" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "One ticket per file",
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
                        id: { type: "string", description: "Media id; pass to /complete" },
                        upload: {
                          type: "object",
                          properties: {
                            method: { type: "string", example: "POST" },
                            url: { type: "string", format: "uri" },
                            fields: { type: "object", additionalProperties: true },
                            fileField: { type: "string", example: "file" },
                            expiresAt: { type: "string", format: "date-time" },
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
        "400": err("Invalid declaration"),
        "401": err("Not signed in"),
        "429": err("Too many unfinished uploads"),
        "501": err("No storage account supports direct upload; use POST /media"),
        "507": err("All storage accounts are full"),
      },
    },
  },
  "/media/{id}/complete": {
    post: {
      tags: ["Media"],
      summary: "Confirm a direct upload finished",
      description:
        "The server asks the storage provider what actually arrived. A file larger than declared, or not an allowed image, is deleted and rejected. Safe to call more than once.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Confirmed (status becomes pending until a post claims it)",
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" }, data: mediaItem } },
            },
          },
        },
        "400": err("Uploaded file did not match the declaration"),
        "404": err("Not found"),
        "409": err("Upload has not finished yet; retry shortly"),
      },
    },
  },
  "/media": {
    post: {
      tags: ["Media"],
      summary: "Fallback: upload up to 8 images through this API (JPEG, PNG, WebP, max 8 MB each)",
      description:
        "Uploads are `pending` until a post claims them; unclaimed uploads are deleted after about an hour. The file type is checked from the file's bytes.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: { files: { type: "array", maxItems: 8, items: { type: "string", format: "binary" } } },
              required: ["files"],
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Uploaded",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { success: { type: "boolean" }, data: { type: "array", items: mediaItem } },
              },
            },
          },
        },
        "400": err("No files, too many files, or not a supported image"),
        "401": err("Not signed in"),
        "413": err("A file is larger than 8 MB"),
        "507": err("All storage accounts are full"),
      },
    },
  },
  "/media/{id}": {
    delete: {
      tags: ["Media"],
      summary: "Delete an unattached upload (owner or staff)",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "204": { description: "Deleted" },
        "404": err("Not found"),
        "409": err("Attached to a post"),
      },
    },
  },
};
