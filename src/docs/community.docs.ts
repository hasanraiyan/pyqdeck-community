/**
 * OpenAPI paths for the community features (posts, comments, members, notifications, reports, links, communities).
 * Written as a compact table because the routes share the same envelope, security and community parameter; the
 * heavier media, moderation and storage paths keep their own `*.docs.ts`.
 */
type Method = "get" | "post" | "put" | "patch" | "delete";
type Auth = "public" | "member" | "moderator" | "admin" | "platform";

interface Row {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  auth: Auth;
  /** Request body fields, as `name: type` pairs for the example schema. */
  body?: Record<string, string>;
  query?: string[];
  status?: number;
  paged?: boolean;
}

const rows: Row[] = [
  // communities
  { method: "get", path: "/", tag: "Communities", summary: "Community info and limits", auth: "public" },
  // posts
  {
    method: "get",
    path: "/posts",
    tag: "Posts",
    summary: "Feed (newest first, cursor pages). Filters: hashtag, q (search)",
    auth: "public",
    query: ["cursor", "limit", "hashtag", "q"],
    paged: true,
  },
  {
    method: "post",
    path: "/posts",
    tag: "Posts",
    summary: "Create a post (send Idempotency-Key to make retries safe)",
    auth: "member",
    body: { body: "string", mediaIds: "string[]", linkedResource: "object" },
    status: 201,
  },
  { method: "get", path: "/posts/{id}", tag: "Posts", summary: "One post by id or slug", auth: "public" },
  {
    method: "patch",
    path: "/posts/{id}",
    tag: "Posts",
    summary: "Edit your post (re-moderated; a held edit keeps the old text live)",
    auth: "member",
    body: { body: "string", mediaIds: "string[]", linkedResource: "object|null" },
  },
  {
    method: "delete",
    path: "/posts/{id}",
    tag: "Posts",
    summary: "Delete your post (disappears immediately; purged after 30 days)",
    auth: "member",
    status: 204,
  },
  { method: "put", path: "/posts/{id}/like", tag: "Reactions", summary: "Like (idempotent)", auth: "member" },
  { method: "delete", path: "/posts/{id}/like", tag: "Reactions", summary: "Remove your like", auth: "member" },
  { method: "put", path: "/posts/{id}/bookmark", tag: "Reactions", summary: "Save (idempotent)", auth: "member" },
  { method: "delete", path: "/posts/{id}/bookmark", tag: "Reactions", summary: "Remove from saved", auth: "member" },
  {
    method: "put",
    path: "/posts/{id}/hide",
    tag: "Posts",
    summary: "Hide from your own feed",
    auth: "member",
    status: 204,
  },
  { method: "delete", path: "/posts/{id}/hide", tag: "Posts", summary: "Undo hide", auth: "member", status: 204 },
  {
    method: "post",
    path: "/posts/{id}/moderate",
    tag: "Moderation",
    summary: "Approve, remove (with reason) or reject a held edit",
    auth: "moderator",
    body: { action: "approve|remove|reject_edit", reason: "string" },
  },
  {
    method: "get",
    path: "/posts/queue",
    tag: "Moderation",
    summary: "Held posts and edits",
    auth: "moderator",
    query: ["cursor", "limit"],
    paged: true,
  },
  {
    method: "get",
    path: "/hashtags/trending",
    tag: "Posts",
    summary: "Top 10 hashtags over 7 days (cached 10 minutes)",
    auth: "public",
  },
  // comments
  {
    method: "get",
    path: "/posts/{id}/comments",
    tag: "Comments",
    summary: "Top-level comments, oldest first",
    auth: "public",
    query: ["cursor", "limit"],
    paged: true,
  },
  {
    method: "post",
    path: "/posts/{id}/comments",
    tag: "Comments",
    summary: "Comment or reply (replies attach to the thread root)",
    auth: "member",
    body: { body: "string", parentId: "string" },
    status: 201,
  },
  {
    method: "get",
    path: "/comments/{commentId}/replies",
    tag: "Comments",
    summary: "Replies of a thread",
    auth: "public",
    query: ["cursor", "limit"],
    paged: true,
  },
  {
    method: "patch",
    path: "/comments/{commentId}",
    tag: "Comments",
    summary: "Edit your comment",
    auth: "member",
    body: { body: "string" },
  },
  {
    method: "delete",
    path: "/comments/{commentId}",
    tag: "Comments",
    summary: "Delete (author, post author or moderator)",
    auth: "member",
    status: 204,
  },
  { method: "put", path: "/comments/{commentId}/like", tag: "Reactions", summary: "Like a comment", auth: "member" },
  {
    method: "delete",
    path: "/comments/{commentId}/like",
    tag: "Reactions",
    summary: "Unlike a comment",
    auth: "member",
  },
  {
    method: "post",
    path: "/comments/{commentId}/moderate",
    tag: "Moderation",
    summary: "Approve, remove or reject a held edit",
    auth: "moderator",
    body: { action: "approve|remove|reject_edit", reason: "string" },
  },
  {
    method: "get",
    path: "/comments/queue",
    tag: "Moderation",
    summary: "Held comments",
    auth: "moderator",
    query: ["cursor", "limit"],
    paged: true,
  },
  // members
  {
    method: "get",
    path: "/members/me",
    tag: "Members",
    summary: "Your membership in this community (private fields included)",
    auth: "member",
  },
  {
    method: "patch",
    path: "/members/me",
    tag: "Members",
    summary: "Edit your persona here (name, handle, headline, bio, links, skills, attributes, avatar/cover media)",
    auth: "member",
  },
  {
    method: "get",
    path: "/members/me/bookmarks",
    tag: "Members",
    summary: "Your saved posts",
    auth: "member",
    query: ["cursor", "limit"],
    paged: true,
  },
  {
    method: "get",
    path: "/members/me/blocked",
    tag: "Members",
    summary: "Members you blocked",
    auth: "member",
    query: ["cursor", "limit"],
    paged: true,
  },
  {
    method: "get",
    path: "/members/search",
    tag: "Members",
    summary: "Search by handle or name",
    auth: "public",
    query: ["q", "limit"],
  },
  {
    method: "get",
    path: "/members/{username}",
    tag: "Members",
    summary: "Public profile with counts and isFollowing",
    auth: "public",
  },
  {
    method: "get",
    path: "/members/{username}/posts",
    tag: "Members",
    summary: "A member's posts",
    auth: "public",
    query: ["cursor", "limit"],
    paged: true,
  },
  {
    method: "get",
    path: "/members/{username}/followers",
    tag: "Social",
    summary: "Followers",
    auth: "public",
    query: ["cursor", "limit"],
    paged: true,
  },
  {
    method: "get",
    path: "/members/{username}/following",
    tag: "Social",
    summary: "Following",
    auth: "public",
    query: ["cursor", "limit"],
    paged: true,
  },
  { method: "put", path: "/members/{username}/follow", tag: "Social", summary: "Follow (idempotent)", auth: "member" },
  {
    method: "delete",
    path: "/members/{username}/follow",
    tag: "Social",
    summary: "Unfollow (idempotent)",
    auth: "member",
  },
  {
    method: "put",
    path: "/members/{username}/block",
    tag: "Social",
    summary: "Block: hides both ways and removes follows",
    auth: "member",
    status: 204,
  },
  {
    method: "delete",
    path: "/members/{username}/block",
    tag: "Social",
    summary: "Unblock",
    auth: "member",
    status: 204,
  },
  {
    method: "put",
    path: "/members/{username}/suspend",
    tag: "Moderation",
    summary: "Suspend a member",
    auth: "moderator",
    body: { reason: "string", until: "date-time" },
    status: 204,
  },
  {
    method: "delete",
    path: "/members/{username}/suspend",
    tag: "Moderation",
    summary: "Lift a suspension",
    auth: "moderator",
    status: 204,
  },
  {
    method: "put",
    path: "/members/{username}/role",
    tag: "Moderation",
    summary: "Set a member's role",
    auth: "admin",
    body: { role: "member|moderator|admin" },
  },
  // notifications
  {
    method: "get",
    path: "/notifications",
    tag: "Notifications",
    summary: "Your notifications (filters: unread, type)",
    auth: "member",
    query: ["cursor", "limit", "unread", "type"],
    paged: true,
  },
  {
    method: "get",
    path: "/notifications/unread-count",
    tag: "Notifications",
    summary: "Unread count for the tab badge",
    auth: "member",
  },
  {
    method: "post",
    path: "/notifications/read-all",
    tag: "Notifications",
    summary: "Mark all read",
    auth: "member",
    status: 204,
  },
  {
    method: "patch",
    path: "/notifications/{id}",
    tag: "Notifications",
    summary: "Mark read or dismiss",
    auth: "member",
    body: { read: "true", dismissed: "true" },
    status: 204,
  },
  {
    method: "delete",
    path: "/notifications/{id}",
    tag: "Notifications",
    summary: "Dismiss",
    auth: "member",
    status: 204,
  },
  // reports
  {
    method: "post",
    path: "/reports",
    tag: "Reports",
    summary: "Report a post, comment, member or link",
    auth: "member",
    body: { targetType: "post|comment|member|link", targetId: "string", reason: "string", note: "string" },
    status: 201,
  },
  {
    method: "get",
    path: "/reports",
    tag: "Reports",
    summary: "Open reports grouped by target",
    auth: "moderator",
    query: ["page", "limit"],
  },
  {
    method: "post",
    path: "/reports/resolve",
    tag: "Reports",
    summary: "Close a group of reports (optionally removing the content)",
    auth: "moderator",
    body: { targetType: "string", targetId: "string", outcome: "actioned|dismissed", remove: "boolean" },
  },
  // links
  {
    method: "get",
    path: "/links/{code}",
    tag: "Links",
    summary: "Destination host and safety verdict of a short link",
    auth: "public",
  },
  {
    method: "post",
    path: "/links/{code}/block",
    tag: "Links",
    summary: "Block one link",
    auth: "moderator",
    status: 204,
  },
  {
    method: "delete",
    path: "/links/{code}/block",
    tag: "Links",
    summary: "Unblock a link",
    auth: "moderator",
    status: 204,
  },
  {
    method: "get",
    path: "/links/blocked-domains/list",
    tag: "Links",
    summary: "Blocked domains of this community",
    auth: "moderator",
  },
  {
    method: "post",
    path: "/links/blocked-domains/list",
    tag: "Links",
    summary: "Block a domain here",
    auth: "moderator",
    body: { domain: "string", reason: "string" },
    status: 201,
  },
  {
    method: "delete",
    path: "/links/blocked-domains/list/{domain}",
    tag: "Links",
    summary: "Unblock a domain",
    auth: "moderator",
    status: 204,
  },
];

const platformRows: Row[] = [
  { method: "get", path: "/v1/admin/communities", tag: "Communities", summary: "List communities", auth: "platform" },
  {
    method: "post",
    path: "/v1/admin/communities",
    tag: "Communities",
    summary: "Create a community at runtime",
    auth: "platform",
    body: { slug: "string", name: "string", limits: "object" },
    status: 201,
  },
  {
    method: "patch",
    path: "/v1/admin/communities/{slug}",
    tag: "Communities",
    summary: "Rename or change limits",
    auth: "platform",
    body: { name: "string", limits: "object" },
  },
  {
    method: "put",
    path: "/v1/admin/communities/{slug}/status",
    tag: "Communities",
    summary: "active, read_only or disabled",
    auth: "platform",
    body: { status: "active|read_only|disabled" },
  },
  {
    method: "get",
    path: "/v1/admin/blocked-domains",
    tag: "Links",
    summary: "Platform-wide blocked domains",
    auth: "platform",
  },
  {
    method: "post",
    path: "/v1/admin/blocked-domains",
    tag: "Links",
    summary: "Block a domain in every community",
    auth: "platform",
    body: { domain: "string", reason: "string" },
    status: 201,
  },
  {
    method: "delete",
    path: "/v1/admin/blocked-domains/{domain}",
    tag: "Links",
    summary: "Unblock",
    auth: "platform",
    status: 204,
  },
];

const AUTH_NOTE: Record<Auth, string> = {
  public: "Public.",
  member: "Requires sign-in.",
  moderator: "Requires the moderator role in this community.",
  admin: "Requires the community admin role.",
  platform: "Requires a platform admin.",
};

const pathParams = (path: string) =>
  [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));

const operation = (row: Row, base: string) => {
  const parameters = [
    ...(base ? [{ name: "community", in: "path", required: true, schema: { type: "string", example: "beu" } }] : []),
    ...pathParams(row.path),
    ...(row.query ?? []).map((name) => ({ name, in: "query", schema: { type: "string" } })),
  ];
  const status = row.status ?? 200;
  return {
    tags: [row.tag],
    summary: row.summary,
    description: AUTH_NOTE[row.auth],
    ...(row.auth !== "public" && { security: [{ bearerAuth: [] }] }),
    parameters,
    ...(row.body && {
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(row.body).map(([k, v]) => [k, { type: "string", description: v }]),
              ),
            },
          },
        },
      },
    }),
    responses: {
      [status]:
        status === 204
          ? { description: "No content" }
          : { description: row.paged ? "A page (pagination.nextCursor, hasMore)" : "OK" },
      ...(row.auth !== "public" && { 401: { description: "Sign in required" }, 403: { description: "Not allowed" } }),
      404: { description: "Not found" },
    },
  };
};

const build = (list: Row[], base: string) => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const row of list) (paths[`${base}${row.path}`] ??= {})[row.method] = operation(row, base);
  return paths;
};

export const communityPaths = {
  ...build(rows, "/v1/communities/{community}"),
  ...build(platformRows, ""),
};

/** Existing module docs list `/media/...`; this moves them under the community path and adds its parameter. */
export function scopePaths(paths: Record<string, Record<string, unknown>>, prefix: string, withCommunity: boolean) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(paths)) {
    out[`${prefix}${path}`] = withCommunity
      ? Object.fromEntries(
          Object.entries(item).map(([method, op]) => [
            method,
            {
              ...(op as object),
              parameters: [
                { name: "community", in: "path", required: true, schema: { type: "string", example: "beu" } },
                ...(((op as { parameters?: unknown[] }).parameters ?? []) as unknown[]),
              ],
            },
          ]),
        )
      : item;
  }
  return out;
}
