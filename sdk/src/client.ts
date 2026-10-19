import { CommunityApiError } from "./errors.js";
import { Http, type HttpOptions, type RequestOptions } from "./http.js";
import type {
  Comment,
  CommunityInfo,
  LinkInfo,
  LinkedResource,
  LocalImage,
  Member,
  MediaItem,
  ModerationEvent,
  ModerationEventFilter,
  PageMeta,
  Notification,
  NotificationType,
  OwnMember,
  Page,
  PageParams,
  Post,
  ProfileUpdate,
  ReportGroup,
  ReportReason,
  ReportTarget,
  TrendingTag,
  UploadTicket,
} from "./types.js";
import { xhrUploader, type FileUploader } from "./upload.js";

export interface CommunityClientOptions extends HttpOptions {
  /** The community this client talks to (`beu`, `gate`, ...). Added to every path; one client per app (IR-SDK-12). */
  community: string;
  /** Override how bytes reach the storage provider (defaults to XMLHttpRequest with progress). */
  uploadFile?: FileUploader;
}

export interface CreatePostInput {
  body?: string;
  mediaIds?: string[];
  linkedResource?: LinkedResource;
}

export interface EditPostInput {
  body?: string;
  mediaIds?: string[];
  linkedResource?: LinkedResource | null;
}

export interface PublishPostInput {
  body?: string;
  images?: LocalImage[];
  linkedResource?: LinkedResource;
  /** 0 to 1: image bytes first, then the final publish step. */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  /** Reuse the same key when retrying so a lost response cannot create a second post. */
  idempotencyKey?: string;
}

export interface FeedParams extends PageParams {
  hashtag?: string;
  /** Search text (2-100 characters). */
  q?: string;
}

const toPage = <T>(env: { data: T[]; pagination?: { nextCursor?: string | null; hasMore?: boolean } }): Page<T> => ({
  items: env.data,
  nextCursor: env.pagination?.nextCursor ?? null,
  hasMore: env.pagination?.hasMore ?? false,
});

/** A new random key for `Idempotency-Key`. */
export const newIdempotencyKey = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

export function createCommunityClient(options: CommunityClientOptions) {
  const http = new Http(options);
  const uploadFile = options.uploadFile ?? xhrUploader;
  const root = `/api/v1/communities/${encodeURIComponent(options.community)}`;
  const enc = encodeURIComponent;

  const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>, o?: RequestOptions) =>
    http.call<T>({ method: "GET", path: root + path, query, ...o });
  const send = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, o?: RequestOptions) =>
    http.call<T>({ method, path: root + path, body, ...o });

  const page = async <T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    o?: RequestOptions,
  ) => toPage<T>(await get<T[]>(path, query, o));

  // ---- posts ----
  const posts = {
    feed: (p: FeedParams = {}, o?: RequestOptions) => page<Post>("/posts", { ...p }, o),
    get: async (idOrSlug: string, o?: RequestOptions) =>
      (await get<Post>(`/posts/${enc(idOrSlug)}`, undefined, o)).data,
    create: async (input: CreatePostInput, o?: RequestOptions & { idempotencyKey?: string }) =>
      (
        await send<Post>("POST", "/posts", input, {
          ...o,
          headers: { ...o?.headers, ...(o?.idempotencyKey && { "Idempotency-Key": o.idempotencyKey }) },
        })
      ).data,
    edit: async (id: string, input: EditPostInput, o?: RequestOptions) =>
      (await send<Post>("PATCH", `/posts/${enc(id)}`, input, o)).data,
    delete: async (id: string, o?: RequestOptions) => void (await send("DELETE", `/posts/${enc(id)}`, undefined, o)),
    like: async (id: string, o?: RequestOptions) =>
      (await send<{ likesCount: number; isLiked: boolean }>("PUT", `/posts/${enc(id)}/like`, undefined, o)).data,
    unlike: async (id: string, o?: RequestOptions) =>
      (await send<{ likesCount: number; isLiked: boolean }>("DELETE", `/posts/${enc(id)}/like`, undefined, o)).data,
    bookmark: async (id: string, o?: RequestOptions) =>
      (await send<{ bookmarksCount: number; isBookmarked: boolean }>("PUT", `/posts/${enc(id)}/bookmark`, undefined, o))
        .data,
    unbookmark: async (id: string, o?: RequestOptions) =>
      (
        await send<{ bookmarksCount: number; isBookmarked: boolean }>(
          "DELETE",
          `/posts/${enc(id)}/bookmark`,
          undefined,
          o,
        )
      ).data,
    hide: async (id: string, o?: RequestOptions) => void (await send("PUT", `/posts/${enc(id)}/hide`, undefined, o)),
    unhide: async (id: string, o?: RequestOptions) =>
      void (await send("DELETE", `/posts/${enc(id)}/hide`, undefined, o)),
    bookmarks: (p: PageParams = {}, o?: RequestOptions) => page<Post>("/members/me/bookmarks", { ...p }, o),
    byMember: (username: string, p: PageParams = {}, o?: RequestOptions) =>
      page<Post>(`/members/${enc(username)}/posts`, { ...p }, o),
    trending: async (o?: RequestOptions) => (await get<TrendingTag[]>("/hashtags/trending", undefined, o)).data,
    moderate: async (
      id: string,
      action: "approve" | "remove" | "reject_edit",
      reason?: ReportReason,
      o?: RequestOptions,
    ) => (await send<Post>("POST", `/posts/${enc(id)}/moderate`, { action, reason }, o)).data,
    queue: (p: PageParams = {}, o?: RequestOptions) => page<Post>("/posts/queue", { ...p }, o),
  };

  // ---- comments ----
  const comments = {
    list: (postId: string, p: PageParams = {}, o?: RequestOptions) =>
      page<Comment>(`/posts/${enc(postId)}/comments`, { ...p }, o),
    replies: (commentId: string, p: PageParams = {}, o?: RequestOptions) =>
      page<Comment>(`/comments/${enc(commentId)}/replies`, { ...p }, o),
    /** `parentId` is any comment of the thread; the server attaches the reply to the thread's top-level comment. */
    create: async (
      postId: string,
      input: { body: string; parentId?: string },
      o?: RequestOptions & { idempotencyKey?: string },
    ) =>
      (
        await send<Comment>("POST", `/posts/${enc(postId)}/comments`, input, {
          ...o,
          headers: { ...o?.headers, ...(o?.idempotencyKey && { "Idempotency-Key": o.idempotencyKey }) },
        })
      ).data,
    edit: async (id: string, body: string, o?: RequestOptions) =>
      (await send<Comment>("PATCH", `/comments/${enc(id)}`, { body }, o)).data,
    delete: async (id: string, o?: RequestOptions) => void (await send("DELETE", `/comments/${enc(id)}`, undefined, o)),
    like: async (id: string, o?: RequestOptions) =>
      (await send<{ likesCount: number; isLiked: boolean }>("PUT", `/comments/${enc(id)}/like`, undefined, o)).data,
    unlike: async (id: string, o?: RequestOptions) =>
      (await send<{ likesCount: number; isLiked: boolean }>("DELETE", `/comments/${enc(id)}/like`, undefined, o)).data,
    moderate: async (
      id: string,
      action: "approve" | "remove" | "reject_edit",
      reason?: ReportReason,
      o?: RequestOptions,
    ) => (await send<Comment>("POST", `/comments/${enc(id)}/moderate`, { action, reason }, o)).data,
    queue: (p: PageParams = {}, o?: RequestOptions) => page<Comment>("/comments/queue", { ...p }, o),
  };

  // ---- members ----
  const members = {
    me: async (o?: RequestOptions) => (await get<OwnMember>("/members/me", undefined, o)).data,
    updateMe: async (patch: ProfileUpdate, o?: RequestOptions) =>
      (await send<OwnMember>("PATCH", "/members/me", patch, o)).data,
    get: async (username: string, o?: RequestOptions) =>
      (await get<Member>(`/members/${enc(username)}`, undefined, o)).data,
    search: async (q: string, limit?: number, o?: RequestOptions) =>
      (await get<Member[]>("/members/search", { q, limit }, o)).data,
    followers: (username: string, p: PageParams = {}, o?: RequestOptions) =>
      page<Member>(`/members/${enc(username)}/followers`, { ...p }, o),
    following: (username: string, p: PageParams = {}, o?: RequestOptions) =>
      page<Member>(`/members/${enc(username)}/following`, { ...p }, o),
    follow: async (username: string, o?: RequestOptions) =>
      (
        await send<{ isFollowing: boolean; followersCount: number }>(
          "PUT",
          `/members/${enc(username)}/follow`,
          undefined,
          o,
        )
      ).data,
    unfollow: async (username: string, o?: RequestOptions) =>
      (
        await send<{ isFollowing: boolean; followersCount: number }>(
          "DELETE",
          `/members/${enc(username)}/follow`,
          undefined,
          o,
        )
      ).data,
    block: async (username: string, o?: RequestOptions) =>
      void (await send("PUT", `/members/${enc(username)}/block`, undefined, o)),
    unblock: async (username: string, o?: RequestOptions) =>
      void (await send("DELETE", `/members/${enc(username)}/block`, undefined, o)),
    blocked: (p: PageParams = {}, o?: RequestOptions) => page<Member>("/members/me/blocked", { ...p }, o),
    suspend: async (username: string, reason: string, until?: string, o?: RequestOptions) =>
      void (await send("PUT", `/members/${enc(username)}/suspend`, { reason, until }, o)),
    unsuspend: async (username: string, o?: RequestOptions) =>
      void (await send("DELETE", `/members/${enc(username)}/suspend`, undefined, o)),
    setRole: async (username: string, role: "member" | "moderator" | "admin", o?: RequestOptions) =>
      (await send<{ username: string; role: string }>("PUT", `/members/${enc(username)}/role`, { role }, o)).data,
  };

  // ---- notifications ----
  const notifications = {
    list: (p: PageParams & { unread?: boolean; type?: NotificationType } = {}, o?: RequestOptions) =>
      page<Notification>("/notifications", { ...p }, o),
    unreadCount: async (o?: RequestOptions) =>
      (await get<{ count: number }>("/notifications/unread-count", undefined, o)).data.count,
    markRead: async (id: string, o?: RequestOptions) =>
      void (await send("PATCH", `/notifications/${enc(id)}`, { read: true }, o)),
    markAllRead: async (o?: RequestOptions) => void (await send("POST", "/notifications/read-all", undefined, o)),
    dismiss: async (id: string, o?: RequestOptions) =>
      void (await send("DELETE", `/notifications/${enc(id)}`, undefined, o)),
  };

  // ---- reports and links ----
  const reports = {
    create: async (
      input: { targetType: ReportTarget; targetId: string; reason: ReportReason; note?: string },
      o?: RequestOptions,
    ) => (await send<{ received: boolean; duplicate: boolean }>("POST", "/reports", input, o)).data,
    queue: async (p: { page?: number; limit?: number } = {}, o?: RequestOptions) =>
      (await get<ReportGroup[]>("/reports", { ...p }, o)).data,
    resolve: async (
      input: { targetType: ReportTarget; targetId: string; outcome: "actioned" | "dismissed"; remove?: boolean },
      o?: RequestOptions,
    ) => (await send<{ closed: number }>("POST", "/reports/resolve", input, o)).data,
  };

  // Moderators and admins only. The history of every content check, allowed results included.
  const moderation = {
    events: async (filter: ModerationEventFilter = {}, o?: RequestOptions) => {
      const res = await http.call<ModerationEvent[]>({
        method: "GET",
        path: `${root}/moderation/events`,
        query: { ...filter, escalate: filter.escalate === undefined ? undefined : String(filter.escalate) },
        ...o,
      });
      return { items: res.data, page: res.pagination as PageMeta };
    },
  };

  const links = {
    /** Destination host and safety verdict, so the app can show its own warning before opening a link. */
    resolve: async (code: string, o?: RequestOptions) =>
      (await get<LinkInfo>(`/links/${enc(code)}`, undefined, o)).data,
    block: async (code: string, o?: RequestOptions) =>
      void (await send("POST", `/links/${enc(code)}/block`, undefined, o)),
    unblock: async (code: string, o?: RequestOptions) =>
      void (await send("DELETE", `/links/${enc(code)}/block`, undefined, o)),
  };

  // ---- media ----
  const media = {
    requestUploads: async (files: Array<{ mimeType: string; size: number }>, o?: RequestOptions) =>
      (await send<Array<{ id: string; upload: UploadTicket }>>("POST", "/media/uploads", { files }, o)).data,
    complete: async (id: string, o?: RequestOptions) =>
      (await send<MediaItem>("POST", `/media/${enc(id)}/complete`, undefined, o)).data,
    remove: async (id: string, o?: RequestOptions) => void (await send("DELETE", `/media/${enc(id)}`, undefined, o)),

    /**
     * The whole direct-upload sequence as one call: ask for tickets, send each image straight to the storage provider,
     * then have the server confirm and check each one. Returns media ids ready to attach (IR-SDK-4). Uploads that were
     * started are removed again if anything fails or the call is cancelled.
     */
    uploadImages: async (
      images: LocalImage[],
      opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
    ): Promise<MediaItem[]> => {
      if (images.length === 0) return [];
      const started: string[] = [];
      try {
        const tickets = await media.requestUploads(
          images.map((i) => ({ mimeType: i.mimeType, size: i.size })),
          { signal: opts.signal },
        );
        started.push(...tickets.map((t) => t.id));

        const total = images.reduce((sum, i) => sum + i.size, 0) || 1;
        const sent = new Array<number>(images.length).fill(0);
        const report = () => opts.onProgress?.(sent.reduce((a, b) => a + b, 0) / total);

        await Promise.all(
          tickets.map((t, i) =>
            uploadFile({
              ticket: t.upload,
              image: images[i],
              signal: opts.signal,
              onProgress: (loaded, size) => {
                sent[i] = Math.min(images[i].size, size ? (loaded / size) * images[i].size : loaded);
                report();
              },
            }).then(() => {
              sent[i] = images[i].size;
              report();
            }),
          ),
        );

        const done: MediaItem[] = [];
        for (const t of tickets) done.push(await media.complete(t.id, { signal: opts.signal }));
        return done;
      } catch (err) {
        await Promise.allSettled(started.map((id) => media.remove(id)));
        throw err;
      }
    },
  };

  /**
   * Publishes a post with its images in one operation, with progress and cancellation (IR-SDK-3). Images count for
   * the first 90% of progress; the final create call for the rest. The server answers 422 when moderation refuses
   * the text, and returns a `pending` post when it is held for review.
   */
  const publishPost = async (input: PublishPostInput): Promise<Post> => {
    const key = input.idempotencyKey ?? newIdempotencyKey();
    input.onProgress?.(0);
    const uploaded = await media.uploadImages(input.images ?? [], {
      signal: input.signal,
      onProgress: (f) => input.onProgress?.(f * 0.9),
    });
    try {
      const post = await posts.create(
        { body: input.body, mediaIds: uploaded.map((m) => m.id), linkedResource: input.linkedResource },
        { signal: input.signal, idempotencyKey: key },
      );
      input.onProgress?.(1);
      return post;
    } catch (err) {
      // A refused or cancelled post must not leave its images behind. A network failure keeps them so a retry can reuse them.
      if (!(err instanceof CommunityApiError) || err.status !== 0) {
        await Promise.allSettled(uploaded.map((m) => media.remove(m.id)));
      }
      throw err;
    }
  };

  return {
    community: options.community,
    info: async (o?: RequestOptions) => (await get<CommunityInfo>("/", undefined, o)).data,
    posts,
    comments,
    members,
    notifications,
    reports,
    moderation,
    links,
    media,
    publishPost,
  };
}

export type CommunityClient = ReturnType<typeof createCommunityClient>;
