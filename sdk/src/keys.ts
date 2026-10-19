/**
 * Query-key factories for TanStack Query. Every key starts with the community, so the caches of different PYQDeck
 * apps can never mix, and `invalidateQueries({ queryKey: communityKeys.all("beu") })` clears one community cleanly.
 * Keys hold only plain JSON, so they persist with the app's AsyncStorage persister.
 */
type Filters = Record<string, string | number | boolean | null | undefined>;

export const communityKeys = {
  all: (community: string) => ["community", community] as const,
  info: (community: string) => [...communityKeys.all(community), "info"] as const,
  feeds: (community: string) => [...communityKeys.all(community), "feed"] as const,
  feed: (community: string, filters: Filters = {}) => [...communityKeys.feeds(community), filters] as const,
  post: (community: string, idOrSlug: string) => [...communityKeys.all(community), "post", idOrSlug] as const,
  comments: (community: string, postId: string) => [...communityKeys.all(community), "comments", postId] as const,
  replies: (community: string, commentId: string) => [...communityKeys.all(community), "replies", commentId] as const,
  me: (community: string) => [...communityKeys.all(community), "me"] as const,
  member: (community: string, username: string) => [...communityKeys.all(community), "member", username] as const,
  memberPosts: (community: string, username: string) =>
    [...communityKeys.all(community), "member-posts", username] as const,
  bookmarks: (community: string) => [...communityKeys.all(community), "bookmarks"] as const,
  notifications: (community: string, filters: Filters = {}) =>
    [...communityKeys.all(community), "notifications", filters] as const,
  unreadCount: (community: string) => [...communityKeys.all(community), "unread-count"] as const,
  trending: (community: string) => [...communityKeys.all(community), "trending"] as const,
  search: (community: string, q: string) => [...communityKeys.all(community), "search", q] as const,
  link: (community: string, code: string) => [...communityKeys.all(community), "link", code] as const,
};
