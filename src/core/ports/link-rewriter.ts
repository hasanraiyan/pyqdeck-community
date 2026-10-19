/**
 * What posts, comments and profiles need from the link service (FR-LNK). They depend on this port, not on the links
 * module; the adapter is the `LinkService` itself, wired in `links.module.ts`.
 */
export type LinkContentType = "post" | "comment" | "profile";

/** The reader-facing form of one external URL. */
export interface LinkRef {
  code: string;
  shortUrl: string;
  /** Destination host, so clients can show where a link goes. */
  host: string;
}

export interface SyncLinksInput {
  communityId: string;
  contentType: LinkContentType;
  contentId: string;
  authorId: string;
  /** Every text of the content that may contain URLs. */
  texts: string[];
  /** Distinct external URLs allowed in this content. */
  maxLinks: number;
  /** Whether the content is visible right now (published). Held content gets inactive links. */
  live: boolean;
}

export interface RenderedContent {
  text: string;
  /** Click counts are included for the caller to show only to the content author (FR-LNK-22). */
  links: Array<LinkRef & { clicks: number }>;
}

export interface LinkRewriter {
  /**
   * Checks every URL in `texts` and creates or reuses one short link per distinct URL. Throws a 422 `AppError`
   * naming the problem for an invalid, blocked or malicious URL, so content is refused rather than silently changed.
   */
  sync(input: SyncLinksInput): Promise<void>;
  /** Activates or deactivates all links of the given content (link status follows content state, FR-LNK-20). */
  setLive(contentType: LinkContentType, contentIds: string[], live: boolean): Promise<void>;
  /** Substitutes short links into the author's original text, for readers. One query for the whole batch. */
  render(
    items: Array<{ contentType: LinkContentType; contentId: string; text: string }>,
  ): Promise<Map<string, RenderedContent>>; // keyed `${contentType}:${contentId}`
  /** The text with URLs removed, so a URL fragment such as `#section` never becomes a hashtag (FR-LNK-6). */
  stripUrls(text: string): string;
}
