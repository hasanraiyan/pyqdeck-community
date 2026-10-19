/** What features need from notifications. Notifying must never fail the action that caused it. */
export type NotificationType = "comment" | "reply" | "upvote" | "follow" | "moderation";
export type NotificationTarget = "post" | "comment" | "member";

export interface NotifyInput {
  communityId: string;
  recipientId: string;
  /** Who did it. The notifier drops the notification when actor and recipient are the same person (FR-NTF-4). */
  actorId?: string;
  type: NotificationType;
  targetType?: NotificationTarget;
  targetId?: string;
  /** Post the target belongs to, so the app can open it (comments, replies). */
  postId?: string;
  title?: string;
  body?: string;
}

export interface Notifier {
  notify(input: NotifyInput): Promise<void>;
  /** Removes notifications that point at content which is no longer visible (FR-NTF-9). */
  removeForTargets(communityId: string, targetType: NotificationTarget, targetIds: string[]): Promise<void>;
}
