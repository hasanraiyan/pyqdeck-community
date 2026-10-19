/** What features need from the media module. Satisfied structurally by `MediaService`. */
export interface AttachedMedia {
  id: string;
  url: string;
}

export interface MediaAttachments {
  /** Claims confirmed uploads of this member for a piece of content; returns their public URLs in the given order. */
  attach(communityId: string, ownerId: string, ids: string[]): Promise<AttachedMedia[]>;
  /** Deletes the files and records. Ids that no longer exist are ignored. */
  release(ids: string[]): Promise<void>;
  /** Public URLs for already attached ids. */
  urlsFor(ids: string[]): Promise<AttachedMedia[]>;
}
