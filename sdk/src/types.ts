/** Shapes returned by the Community API. Dates are ISO strings so responses can be persisted as plain JSON. */

export type Role = "member" | "moderator" | "admin";
export type PostStatus = "published" | "pending" | "rejected" | "deleted";
export type CommentStatus = PostStatus;

export interface Author {
  /** null only for a deleted member who has no row left to point at. */
  id: string | null;
  /** null for deleted members, who render as "Deleted user". */
  username: string | null;
  displayName: string;
  avatarUrl: string;
  headline: string;
  role: Role;
}

export interface LinkRef {
  code: string;
  /** What readers see in the text, e.g. https://go.pyqdeck.in/aB3dE5gH */
  shortUrl: string;
  /** Destination host, to show next to the link. */
  host: string;
  /** Only present on your own content. */
  clicks?: number;
}

export interface PostMedia {
  id: string;
  url: string;
}

export interface LinkedResource {
  type: "pyq" | "topic";
  title: string;
  subtitle?: string;
  subjectId?: string;
  semesterId?: string;
  year?: number;
  questionId?: string;
  topicId?: string;
}

export interface Post {
  id: string;
  slug: string;
  author: Author;
  /** The text readers see, with short links substituted. */
  body: string;
  hashtags: string[];
  media: PostMedia[];
  linkedResource: LinkedResource | null;
  links: LinkRef[];
  status: PostStatus;
  likesCount: number;
  commentsCount: number;
  bookmarksCount: number;
  isLiked: boolean;
  isBookmarked: boolean;
  isOwnPost: boolean;
  editedAt: string | null;
  createdAt: string;
  // Own posts only:
  /** The text as typed, for the edit form. */
  rawBody?: string;
  heldReason?: "moderation" | "reports" | null;
  removedReason?: string | null;
  hasPendingEdit?: boolean;
}

export interface Comment {
  id: string;
  postId: string;
  /** The thread's top-level comment; null for a top-level comment itself. */
  parentId: string | null;
  author: Author;
  replyTo: { id: string | null; username: string | null; displayName: string } | null;
  body: string;
  links: LinkRef[];
  status: CommentStatus;
  likesCount: number;
  repliesCount: number;
  isLiked: boolean;
  isOwn: boolean;
  editedAt: string | null;
  createdAt: string;
  rawBody?: string;
  /** Own comments and, for moderators, anyone's. */
  heldReason?: "moderation" | "reports" | null;
  removedReason?: string | null;
  hasPendingEdit?: boolean;
}

export interface Member extends Author {
  coverUrl: string;
  bio: string;
  location: string;
  github: string;
  linkedin: string;
  twitter: string;
  website: string;
  websiteLink: LinkRef | null;
  skills: string[];
  attributes: Record<string, string | number | boolean | null>;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  upvotesCount: number;
  joinedAt: string;
  isFollowing?: boolean;
}

export interface OwnMember extends Member {
  email: string;
  status: "active" | "suspended" | "deleted";
  suspendedUntil: string | null;
  isPlatformAdmin: boolean;
}

export interface ProfileUpdate {
  username?: string;
  displayName?: string;
  headline?: string;
  bio?: string;
  location?: string;
  github?: string;
  linkedin?: string;
  twitter?: string;
  website?: string;
  skills?: string[];
  attributes?: Record<string, string | number | boolean | null>;
  /** Media ids from `media.uploadImages`; null removes the image. */
  avatarMediaId?: string | null;
  coverMediaId?: string | null;
}

export type NotificationType = "comment" | "reply" | "upvote" | "follow" | "moderation";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  /** For aggregated upvotes: "received N new upvotes". */
  count: number;
  actor: Author | null;
  target: { type: "post" | "comment" | "member"; id: string | null; postId: string | null } | null;
  createdAt: string;
}

export interface TrendingTag {
  tag: string;
  count: number;
}

export interface CommunityInfo {
  slug: string;
  name: string;
  status: "active" | "read_only" | "disabled";
  limits: {
    postMaxChars: number;
    commentMaxChars: number;
    maxImagesPerPost: number;
    maxLinksPerPost: number;
    maxLinksPerComment: number;
  };
}

export interface MediaItem {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  status: "uploading" | "pending" | "attached";
}

export interface UploadTicket {
  method: "POST";
  url: string;
  fields: Record<string, string | number>;
  fileField: string;
  expiresAt: string;
}

export type ReportReason = "spam" | "harassment" | "hate" | "sexual" | "violence" | "misinformation" | "other";
export type ReportTarget = "post" | "comment" | "member" | "link";

export interface ReportGroup {
  targetType: ReportTarget;
  targetId: string;
  count: number;
  reasons: ReportReason[];
  notes: string[];
  firstReportedAt: string;
  /** What the reported thing is, so a moderator does not have to open it. Null if it no longer exists. */
  preview: {
    title: string;
    snippet?: string;
    authorUsername?: string | null;
    /** The post to open (the post itself, or the post a comment belongs to). */
    postId?: string;
    status?: string;
  } | null;
}

export interface LinkInfo {
  code: string;
  host: string;
  verdict: "clean" | "suspicious" | "malicious" | "unchecked";
  status: "active" | "inactive" | "blocked";
  /** What a tap would do: open at once, show the warning page, or refuse. */
  decision: "redirect" | "warn" | "blocked" | "gone" | "notfound";
}

/** One result of the content check. The content itself is never stored, only who, where, the result and the scores. */
export interface ModerationEvent {
  _id: string;
  /** The member who submitted it. */
  userId?: string;
  /** Where it was submitted: media, post, comment or profile. */
  source: string;
  /** The checked thing: a media id for images. */
  sourceId?: string;
  action: "allow" | "review" | "reject";
  /** The checker was unavailable, so there is no real verdict. */
  degraded: boolean;
  /** Sexual content involving minors: needs the child-safety process. */
  escalate: boolean;
  categories: string[];
  scores: Record<string, number>;
  /** Which checker decided, e.g. openai or profanity-filter. */
  provider: string;
  createdAt: string;
}

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface ModerationEventFilter {
  page?: number;
  limit?: number;
  action?: "allow" | "review" | "reject";
  source?: string;
  sourceId?: string;
  userId?: string;
  escalate?: boolean;
}

/** A cursor page. Pass `nextCursor` back to get the next one. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PageParams {
  cursor?: string;
  limit?: number;
}

/** A picked image on the device, before it is uploaded. */
export interface LocalImage {
  uri: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** Bytes. Declared to the server up front so storage can be reserved. */
  size: number;
  name?: string;
}
