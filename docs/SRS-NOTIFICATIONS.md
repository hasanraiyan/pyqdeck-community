# Software Requirements Specification: Notification Subsystem

Part of the PYQDeck Community Service. Follows the conventions of `docs/SRS.md` (ISO/IEC/IEEE 29148:2018): IDs, "shall"
wording, MoSCoW priority, **Source**, **Status** and **V** (verification) columns. This document is the authority for
notifications; it **refines and replaces** the notification requirements FR-NTF-1 to FR-NTF-10 of SRS v1.5 (mapping in
section 7.1).

| Field            | Value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| System           | PYQDeck Community Service (`pyqdeck-community`), its SDK and the Expo app (`pyqdeck-expo`)  |
| Document version | 1.0 (draft for review)                                                                      |
| Date             | 2026-10-19                                                                                  |
| Status           | Draft. Written after a code review of the current notification module and external research |
| Audience         | Product owner, backend and app developers, QA                                               |

**Status values.** `Built` (works today), `Partial` (exists but incomplete, wrong, or not yet verified end to end), `Not built`. Status was set by reading the code on 2026-10-19; behaviour was not re-run for every item.
**Source.** `Code:` observed in the repository, `Owner:` decision by the product owner, `Research:` taken from the
references in section 8, `Proposed:` introduced here. Items marked **TBD-Nn** need a decision (section 7.3).

---

## 1. Introduction

### 1.1 Purpose

To specify how the Community Service tells members about things that concern them: what events produce a notification,
how notifications are grouped, retracted and shown in the in-app inbox, how they are delivered as push notifications to
a phone, how members control them, and the quality attributes the subsystem must meet.

### 1.2 Scope

**In scope**

- Notification events, types, priorities and wording.
- The in-app inbox: list, unread count, read, dismiss, grouping, retention.
- Correct handling of like/unlike flapping, content deletion, blocking, suspension and account deletion.
- Device registration and push delivery through the Expo Push Service, including batching, retries and receipts.
- Member preferences: per type, quiet hours, muting a post.
- Rate control and coalescing so members are never flooded.
- Staff (moderator/admin) notifications.
- The changes required in the SDK and the app.

**Out of scope (this release)**

- Email and SMS delivery, and e-mail digests (candidate for a later release, TBD-N5).
- Web push. Notifications for the main PYQDeck server (papers, syllabus), which has its own push mechanism.
- Direct messages and chat. Marketing or broadcast announcements.
- Real-time in-app updates over a socket; the app polls (FR-CLI-3).

### 1.3 Current state (as reviewed on 2026-10-19)

| Area       | What exists today                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types      | `comment`, `reply`, `upvote`, `follow`, `moderation`. Created in `NotificationService.notify`, best effort, never failing the action that caused it |
| Inbox API  | List (cursor), unread count, mark all read, mark one read, dismiss. Likes aggregate to one row per post                                             |
| Cleanup    | Notifications about a deleted or moderator-removed post or comment are removed (`removeForTargets`); there is no age-based expiry                   |
| App        | Activity tab with list, tap-to-open, read, dismiss; unread badge polled every 60 s. **Hidden** behind `COMMUNITY_NOTIFICATIONS_ENABLED = false`     |
| Push       | **None** from the Community Service. The app can obtain an Expo push token, but only the main server stores and uses it                             |
| Known flaw | A like notifies every time the like switches on, and each one adds to the aggregate count; an unlike removes nothing (see FR-LKE-1 to FR-LKE-6)     |

### 1.4 Definitions

| Term              | Meaning                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Notification      | One inbox row for one recipient (a member of one community).                                                                      |
| Group             | A row that stands for several events on the same target and type, for example "A, B and 3 others liked your post".                |
| Actor             | The member whose action caused the event.                                                                                         |
| Recipient         | The member told about the event.                                                                                                  |
| Target            | The post, comment or member the event is about.                                                                                   |
| Delivery          | One attempt to send a push for one notification state to one device.                                                              |
| Device            | A phone's push registration: an Expo push token tied to a member.                                                                 |
| Coalescing window | The time a low-priority push is held so that several events can be sent as one.                                                   |
| Urgent / social   | Priority classes (FR-NEV-3). Urgent events skip coalescing and quiet hours; social events respect them.                           |
| Flapping          | Repeating an action and its reverse (like, unlike, like ...) on the same target.                                                  |
| Ticket / receipt  | Expo's two-step answer: a ticket says Expo accepted the message; a receipt, fetched later, says whether Apple/Google accepted it. |

---

## 2. Overall description

### 2.1 Context

```
 action (like, comment, follow, moderation ...)
        |
        v
  [Domain service] --notify()--> [NotificationService] --writes--> notifications (inbox)
                                        |
                                        +--decides--> push_deliveries (pending, sendAfter)
                                                              |
                                                     [PushSender job] --batches of 100--> Expo Push Service --> FCM / APNs --> phone
                                                              |
                                                     [ReceiptChecker job] --> mark delivered / failed / remove dead device
```

Domain services (posts, comments, social, moderation outcomes) call the `Notifier` port and know nothing about push.
The inbox row is the source of truth; a push is derived from it and can always be dropped without losing information.

### 2.2 Actors

| Actor             | Interest                                                                            |
| ----------------- | ----------------------------------------------------------------------------------- |
| Member            | Wants to know about replies, comments, follows and likes, and to control how often. |
| Moderator/admin   | Wants to know when content waits for review, without being paged constantly.        |
| Operator          | Wants delivery metrics, a kill switch and no runaway sending.                       |
| Expo Push Service | External provider that relays to Google (FCM) and Apple (APNs).                     |

### 2.3 Design principles

1. **Inbox and push are separate.** The inbox is complete and always correct. Push is best effort and throttled.
2. **State, not increments.** A group shows the real current state (who liked, how many now), recomputed from the source records, so unlike and deletion cannot leave it wrong.
3. **No alert twice for the same person and thing.** Flapping never re-alerts.
4. **Decide first, then send.** Preference, quiet hours, caps and coalescing are applied in one decision step; the sender is simple.
5. **Fail soft.** A notification failure never fails the action that caused it. A push failure never loses the inbox row.
6. **Say little.** Notification text never contains content that was held, refused or removed.

---

## 3. Functional requirements

### 3.1 Events and types (FR-NEV)

| ID        | Requirement                                                                                                                                                                                                                                                                                                           | Pri | Source   | Status    | V   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-NEV-1  | The system shall create a notification when: a member comments on the recipient's post (`comment`); replies to the recipient's comment (`reply`); likes the recipient's post (`upvote`); follows the recipient (`follow`); or a moderation outcome concerns the recipient's content (`moderation`).                   | M   | Code     | Built     | T   |
| FR-NEV-2  | The system shall additionally create: `mention` when a member is @-mentioned in a published post or comment; `review` when the recipient's held post or comment is approved or rejected; `like_comment` when the recipient's comment is liked (grouped like post likes); and `staff_queue` for moderators (FR-NST-1). | S   | Proposed | Not built | T   |
| FR-NEV-3  | The system shall assign each type a priority class: **urgent** = `reply`, `comment`, `mention`, `moderation`, `review`; **social** = `upvote`, `like_comment`, `follow`; **staff** = `staff_queue`.                                                                                                                   | M   | Research | Not built | I   |
| FR-NEV-4  | The system shall never create a notification for a member's own action.                                                                                                                                                                                                                                               | M   | Code     | Built     | T   |
| FR-NEV-5  | The system shall create no notification, and no push, for an event whose actor and recipient have a block between them in either direction.                                                                                                                                                                           | M   | Proposed | Not built | T   |
| FR-NEV-6  | The system shall create no notification for events on content that is not published (pending review, rejected, held, deleted), except the author-facing `moderation` and `review` types.                                                                                                                              | M   | Proposed | Partial   | T   |
| FR-NEV-7  | The system shall create at most one `mention` notification per mentioned member per piece of content, and none for a mention inside quoted or code text.                                                                                                                                                              | S   | Proposed | Not built | T   |
| FR-NEV-8  | The system shall create notifications on a best-effort basis: an error while creating one shall be logged and shall not fail or delay the originating request.                                                                                                                                                        | M   | Code     | Built     | T   |
| FR-NEV-9  | The system shall write the notification text from a per-type template using the actor's display name, and shall store title (at most 200 characters) and body (at most 500).                                                                                                                                          | M   | Code     | Built     | T   |
| FR-NEV-10 | The system shall support adding a new notification type by adding one entry to a single type table (priority class, template, group rule, default preference), with no other branching on type.                                                                                                                       | S   | Proposed | Not built | I   |

### 3.2 Inbox (FR-INB)

| ID        | Requirement                                                                                                                                                                                                        | Pri | Source   | Status    | V   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------- | --------- | --- |
| FR-INB-1  | The system shall list a member's notifications newest first with cursor pagination, filterable by unread and by type, excluding dismissed ones.                                                                    | M   | Code     | Built     | T   |
| FR-INB-2  | The system shall order a group by the time of its **most recent** event, so a new event moves the group to the top.                                                                                                | M   | Research | Partial   | T   |
| FR-INB-3  | The system shall return the unread count, counting each group once, and shall cap the displayed value at 99 in the clients.                                                                                        | M   | Code     | Built     | T   |
| FR-INB-4  | The system shall mark one notification read, and shall mark all of a member's notifications read in one request.                                                                                                   | M   | Code     | Built     | T   |
| FR-INB-5  | The system shall let a member dismiss a notification persistently; a dismissed notification shall not reappear unless its group receives a new event from a new actor.                                             | M   | Code     | Partial   | T   |
| FR-INB-6  | The system shall return, for each notification, its type, group summary, up to three most recent actors (id, handle, name, avatar), the actor count, target (type and id), post id, read state, and `lastEventAt`. | M   | Proposed | Partial   | T   |
| FR-INB-7  | The system shall answer 404 for a notification that does not belong to the caller, identical to one that does not exist.                                                                                           | M   | Code     | Built     | T   |
| FR-INB-8  | The system shall delete notifications 90 days after creation (read or not), and dismissed ones after 7 days (TBD-N4).                                                                                              | S   | Proposed | Not built | T   |
| FR-INB-9  | The system shall keep the inbox per community: a member's notifications in one community shall not appear in or count toward another.                                                                              | M   | Code     | Built     | T   |
| FR-INB-10 | The system shall list notifications of a suspended member read-only, and none for a deleted account.                                                                                                               | S   | Proposed | Not built | T   |

### 3.3 Grouping and like handling (FR-LKE)

A "like" here means a like on a post (and, from FR-NEV-2, on a comment).

| ID       | Requirement                                                                                                                                                                                           | Pri | Source   | Status    | V   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-LKE-1 | The system shall keep **one group per recipient, type and target**, and shall record the set of distinct actors in it (the three most recent in full, the rest as a count).                           | M   | Proposed | Partial   | T   |
| FR-LKE-2 | The system shall derive a group's actor count from the live like records, not from a running counter, so that the displayed number always equals the number of members who currently like the target. | M   | Proposed | Not built | T   |
| FR-LKE-3 | When a like is removed (unlike), the system shall remove that actor from the group, reduce the count, and shall delete the group when it reaches zero.                                                | M   | Proposed | Not built | T   |
| FR-LKE-4 | When a member likes, unlikes and likes again, the system shall not add to the count twice, shall not mark the group unread again, and shall not schedule another push for that member.                | M   | Proposed | Not built | T   |
| FR-LKE-5 | The system shall mark a group unread again only when a **new distinct actor** is added and the previous unread flag was cleared, and at most once every 10 minutes per group.                         | M   | Code     | Partial   | T   |
| FR-LKE-6 | The system shall make the unlike path idempotent and safe under concurrent requests: two simultaneous likes or unlikes by the same member shall leave one consistent result.                          | M   | Proposed | Not built | T   |
| FR-LKE-7 | The system shall word a group by its actor count: one actor "A liked your post"; two "A and B liked your post"; more "A, B and N others liked your post".                                             | M   | Research | Not built | T   |
| FR-LKE-8 | The system shall apply the same grouping rule to `follow` (grouped by recipient) and `like_comment` (grouped by comment). `comment` and `reply` are not grouped.                                      | S   | Proposed | Not built | T   |
| FR-LKE-9 | The system shall remove an actor from all groups when that actor is blocked by the recipient, suspended, or deletes their account.                                                                    | M   | Proposed | Not built | T   |

### 3.4 Retraction and visibility (FR-RTR)

| ID       | Requirement                                                                                                                                                     | Pri | Source   | Status    | V   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-RTR-1 | The system shall delete the notifications about a post or comment when it is deleted, removed by moderation, or auto-hidden by reports.                         | M   | Code     | Partial   | T   |
| FR-RTR-2 | The system shall restore nothing automatically when content is released again; new events shall create new notifications.                                       | S   | Proposed | Built     | T   |
| FR-RTR-3 | The system shall, when a post is edited into review (a revision held), keep existing notifications about it.                                                    | S   | Proposed | Partial   | T   |
| FR-RTR-4 | The system shall cancel every still-pending push for a notification that is retracted, dismissed or marked read before it is sent.                              | M   | Proposed | Not built | T   |
| FR-RTR-5 | The system shall remove a member's notifications and registered devices when their account is deleted, within the same run as the other account-deletion steps. | M   | Code     | Partial   | T   |
| FR-RTR-6 | The system shall hide, without deleting, the notifications whose actor is blocked by the recipient, and shall show them again if the block is lifted.           | S   | Proposed | Not built | T   |

### 3.5 Devices and push tokens (FR-DEV)

| ID       | Requirement                                                                                                                                                                                          | Pri | Source   | Status    | V   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-DEV-1 | The system shall let a signed-in member register a device: Expo push token, platform, app version, locale and timezone (IANA name).                                                                  | M   | Proposed | Not built | T   |
| FR-DEV-2 | The system shall validate the token format (`ExponentPushToken[...]`), and shall keep at most 10 devices per member, replacing the least recently seen.                                              | M   | Proposed | Not built | T   |
| FR-DEV-3 | The system shall bind a token to **one** member at a time: registering a token that belongs to another member shall move it, so a shared phone never delivers one person's notifications to another. | M   | Proposed | Not built | T   |
| FR-DEV-4 | The system shall unregister a device when the member signs out in the app, and the app shall call this before the session ends.                                                                      | M   | Proposed | Not built | T   |
| FR-DEV-5 | The system shall refresh a device's `lastSeenAt` on each registration call, and shall delete devices not seen for 60 days.                                                                           | S   | Proposed | Not built | T   |
| FR-DEV-6 | The system shall disable a device when Expo reports `DeviceNotRegistered` (in a ticket or a receipt) and shall not send to it again until the app registers it.                                      | M   | Research | Not built | T   |
| FR-DEV-7 | The system shall scope devices per community membership: a member's devices in one community shall not receive pushes for another community.                                                         | M   | Proposed | Not built | T   |
| FR-DEV-8 | The system shall accept registration only from the authenticated member and shall never reveal another member's tokens.                                                                              | M   | Proposed | Not built | T   |
| FR-DEV-9 | The system shall list the caller's own devices (platform, app version, last seen) and let them remove one.                                                                                           | C   | Proposed | Not built | T   |

### 3.6 Push delivery (FR-PSH)

| ID        | Requirement                                                                                                                                                                                                            | Pri | Source   | Status    | V   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-PSH-1  | The system shall, for each new notification or changed group, make one **decision** that returns send-now, send-later (with a time) or drop, from the type's priority, the member's preferences, quiet hours and caps. | M   | Research | Not built | T   |
| FR-PSH-2  | The system shall store each planned push as a delivery record with state `pending`, `sending`, `sent`, `delivered`, `failed` or `cancelled`, and a `sendAfter` time.                                                   | M   | Proposed | Not built | T   |
| FR-PSH-3  | The system shall hold **social** pushes for a coalescing window (default 3 minutes, TBD-N1) and send one push describing the group's state at send time; if the group is empty by then, the push shall be cancelled.   | M   | Owner    | Not built | T   |
| FR-PSH-4  | The system shall send **urgent** pushes without delay, apart from the cap in FR-NRC-2.                                                                                                                                 | M   | Research | Not built | T   |
| FR-PSH-5  | The system shall claim due deliveries atomically so that, with several server instances, each is sent once.                                                                                                            | M   | Proposed | Not built | T   |
| FR-PSH-6  | The system shall send in batches of at most 100 messages per request, at no more than 600 messages per second per project, with a payload of at most 4096 bytes.                                                       | M   | Research | Not built | T   |
| FR-PSH-7  | The system shall retry a send on HTTP 429 and 5xx with exponential backoff and jitter, up to 5 attempts over about 30 minutes, then mark the delivery `failed`.                                                        | M   | Research | Not built | T   |
| FR-PSH-8  | The system shall fetch receipts for sent deliveries about 15 minutes after sending, in batches of at most 1000 ticket ids, and always within 24 hours (when Expo discards them).                                       | M   | Research | Not built | T   |
| FR-PSH-9  | The system shall map each ticket and receipt back to its device and delivery, so a `DeviceNotRegistered` or `MessageTooBig` error is recorded against the right record.                                                | M   | Research | Not built | T   |
| FR-PSH-10 | The system shall put in each push: title, short body, the notification id, type, community slug, post/comment/member target and `postId`, so a tap can open the exact screen.                                          | M   | Proposed | Not built | T   |
| FR-PSH-11 | The system shall use one Android notification channel per type group (replies and comments, likes, follows, moderation, staff) so members can also control them in system settings.                                    | S   | Research | Not built | I   |
| FR-PSH-12 | The system shall send one push to each of a member's active devices, and shall not send a push for a notification the member already read.                                                                             | M   | Proposed | Not built | T   |
| FR-PSH-13 | The system shall support Expo "enhanced push security": when an access token is configured it shall send it as a Bearer header.                                                                                        | S   | Research | Not built | I   |
| FR-PSH-14 | The system shall provide a global kill switch (`PUSH_ENABLED`) and a per-community switch, turning sending off without a deploy, while the inbox keeps working.                                                        | M   | Proposed | Not built | T   |
| FR-PSH-15 | The system shall keep delivery records for 30 days for diagnosis and then delete them.                                                                                                                                 | S   | Proposed | Not built | T   |

### 3.7 Preferences (FR-NPF)

| ID       | Requirement                                                                                                                                                                         | Pri | Source   | Status    | V   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-NPF-1 | The system shall store, per membership, whether push is enabled for each type group: replies and comments, mentions, likes, follows, moderation and staff.                          | M   | Research | Not built | T   |
| FR-NPF-2 | The system shall default every group to on, except likes, which default to on but coalesced, and staff, which defaults to on only for moderators and admins (TBD-N2).               | M   | Proposed | Not built | T   |
| FR-NPF-3 | The system shall let a member set quiet hours (start, end) in their own timezone; push of social type shall be held until quiet hours end, urgent types shall not be held (TBD-N3). | S   | Research | Not built | T   |
| FR-NPF-4 | The system shall let a member mute a post: no notifications of any type about it, inbox included, until unmuted. The post's author may mute their own post.                         | S   | Proposed | Not built | T   |
| FR-NPF-5 | The system shall never let a preference suppress the **inbox** row for `moderation` and `review` notifications; push for them may be disabled only via the moderation group.        | M   | Proposed | Not built | T   |
| FR-NPF-6 | The system shall expose preferences through the API (`GET` and `PATCH`) with validation, and reject unknown keys.                                                                   | M   | Proposed | Not built | T   |
| FR-NPF-7 | The system shall apply a preference change to pushes not yet sent, cancelling those it now forbids.                                                                                 | S   | Proposed | Not built | T   |

### 3.8 Rate control (FR-NRC)

| ID       | Requirement                                                                                                                                                                                                 | Pri | Source   | Status    | V   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-NRC-1 | The system shall allow at most one push per member per target and type group within the coalescing window.                                                                                                  | M   | Research | Not built | T   |
| FR-NRC-2 | The system shall cap pushes per member at 10 per hour and 40 per day; once exceeded it shall hold further pushes and send one "You have N new notifications" push when the hour ends (limits configurable). | M   | Research | Not built | T   |
| FR-NRC-3 | The system shall never let the caps drop an inbox row; only pushes are throttled.                                                                                                                           | M   | Proposed | Not built | T   |
| FR-NRC-4 | The system shall bypass the caps and quiet hours for `moderation` and `review` notifications, within a separate limit of 5 per hour.                                                                        | S   | Research | Not built | T   |
| FR-NRC-5 | The system shall detect a burst against one recipient (for example 200 likes in a minute on a viral post) and handle it as one group with one push, not 200 deliveries.                                     | M   | Proposed | Not built | T   |
| FR-NRC-6 | The system shall cap notifications **caused by one actor** towards one recipient at 20 per hour, so a single member cannot spam someone through comments or follows.                                        | S   | Proposed | Not built | T   |

### 3.9 Staff notifications (FR-NST)

| ID       | Requirement                                                                                                                                                                           | Pri | Source   | Status    | V   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-NST-1 | The system shall tell moderators and admins of a community when items are waiting (held content or reports), as one rolling `staff_queue` notification with the current count.        | S   | Owner    | Not built | T   |
| FR-NST-2 | The system shall send at most one `staff_queue` push per staff member per 30 minutes, and none when the queue is empty.                                                               | S   | Proposed | Not built | T   |
| FR-NST-3 | The system shall notify staff immediately (outside the 30-minute limit) when an `escalate` (child-safety) outcome occurs, naming only the community and the count, never the content. | S   | Proposed | Not built | T   |
| FR-NST-4 | The system shall deliver staff notifications only to members whose role is `moderator` or `admin` in that community at the time of sending.                                           | M   | Proposed | Not built | T   |

### 3.10 Content and privacy of notifications (FR-NCT)

| ID       | Requirement                                                                                                                                                                                         | Pri | Source   | Status    | V   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-NCT-1 | The system shall not quote held, refused or removed content in any notification or push; it shall give the reason category only.                                                                    | M   | Code     | Partial   | T   |
| FR-NCT-2 | The system shall show an excerpt (at most 80 characters) of a comment or post in `comment`, `reply` and `mention` pushes only when the content is published and the recipient is allowed to see it. | S   | Proposed | Not built | T   |
| FR-NCT-3 | The system shall never include an e-mail address, Clerk id, account id or moderation scores in a notification or push payload.                                                                      | M   | Proposed | Partial   | T   |
| FR-NCT-4 | The system shall render a deleted or suspended actor as "Deleted user" / omit them, and shall not link to their profile.                                                                            | M   | Code     | Built     | T   |
| FR-NCT-5 | The system shall let the recipient's lock screen show a generic text when the member turns on "hide content on lock screen" (`private: true` preference).                                           | C   | Proposed | Not built | T   |

### 3.11 Clients: SDK and app (FR-NCL)

| ID       | Requirement                                                                                                                                                                           | Pri | Source   | Status    | V   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-NCL-1 | The SDK shall expose: `notifications.list/markRead/markAllRead/dismiss/unreadCount`, `devices.register/unregister/list`, `notifications.preferences.get/update`, `posts.mute/unmute`. | M   | Proposed | Partial   | T   |
| FR-NCL-2 | The app shall ask for the OS notification permission at a meaningful moment (after the first like or comment, or in settings), never on first launch, and explain why.                | M   | Research | Not built | D   |
| FR-NCL-3 | The app shall refresh the unread badge when it returns to the foreground and every 60 seconds while visible, and shall not poll when the inbox is switched off.                       | M   | Code     | Built     | D   |
| FR-NCL-4 | The app shall open the exact screen for a tapped push (post, comment thread or profile), including from a cold start, and shall mark the notification read.                           | M   | Proposed | Not built | D   |
| FR-NCL-5 | The app shall register the device on sign-in and on every start, and unregister it on sign-out.                                                                                       | M   | Proposed | Not built | D   |
| FR-NCL-6 | The app shall show a settings screen with the switches of FR-NPF-1, quiet hours, and a link to the system notification settings.                                                      | S   | Proposed | Not built | D   |
| FR-NCL-7 | The app shall show grouped notifications with stacked avatars and the wording of FR-LKE-7, and shall move a group to the top when it receives a new event.                            | M   | Research | Not built | D   |
| FR-NCL-8 | The app shall keep the Activity inbox hidden while `COMMUNITY_NOTIFICATIONS_ENABLED` is `false` and show it, with its badge and header shortcut, when `true`.                         | M   | Owner    | Built     | I   |
| FR-NCL-9 | The app shall treat an expired login (401) from any notification call by showing the sign-in sheet once, not an error on each poll.                                                   | S   | Proposed | Not built | D   |

### 3.12 Operations (FR-NOP)

| ID       | Requirement                                                                                                                                                                                                | Pri | Source   | Status    | V   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --------- | --- |
| FR-NOP-1 | The system shall run the push sender and receipt checker as background jobs in the API process, each safe to run on several instances (FR-PSH-5) and skipping a run while the previous one is still going. | M   | Code     | Not built | T   |
| FR-NOP-2 | The system shall log, per run, the number of deliveries claimed, sent, failed, cancelled and devices disabled, without tokens or content.                                                                  | M   | Proposed | Not built | I   |
| FR-NOP-3 | The system shall expose to admins, per community and day: notifications created by type, pushes sent, delivered, failed by error, devices active, and cap hits.                                            | S   | Proposed | Not built | D   |
| FR-NOP-4 | The system shall support replaying nothing: a delivery that was `failed` shall not be retried after its retry window, so a long outage never produces a flood of old pushes on recovery.                   | M   | Proposed | Not built | T   |
| FR-NOP-5 | The system shall drop a pending push that is older than one hour at send time (stale), and keep only the inbox row.                                                                                        | M   | Proposed | Not built | T   |

---

## 4. State models

### 4.1 Notification (inbox row)

```
 (event) --> unread --read--> read
              |  ^             |
              |  +-- new actor (after 10 min, FR-LKE-5)
              +--dismiss--> dismissed --(7 d)--> deleted
 any state --retract (content deleted / actor blocked / group empty)--> deleted
 any state --(90 d)--> deleted
```

### 4.2 Push delivery

| From      | To          | Trigger                                                        |
| --------- | ----------- | -------------------------------------------------------------- |
| (none)    | `pending`   | Decision step returned send-now or send-later                  |
| `pending` | `cancelled` | Retracted, read, dismissed, preference off, group empty, stale |
| `pending` | `sending`   | Claimed by the sender (atomic)                                 |
| `sending` | `sent`      | Expo accepted the message (ticket ok)                          |
| `sending` | `pending`   | 429 / 5xx; `sendAfter` moved by backoff                        |
| `sending` | `failed`    | Retries exhausted, or a permanent ticket error                 |
| `sent`    | `delivered` | Receipt ok                                                     |
| `sent`    | `failed`    | Receipt error (device token disabled if `DeviceNotRegistered`) |

Every transition shall be one guarded atomic update, as for other entities (NFR-REL-5 of SRS v1.5).

### 4.3 Device

`active` -> `disabled` (DeviceNotRegistered) -> `active` (app registers again) ; `active` or `disabled` -> deleted (sign-out, 60 days unseen, account deletion).

---

## 5. External interfaces

### 5.1 HTTP API (all under `/api/v1/communities/:community`)

| Method and path                     | Purpose                                   | Status    |
| ----------------------------------- | ----------------------------------------- | --------- |
| `GET /notifications`                | List (cursor, `unread`, `type`)           | Built     |
| `GET /notifications/unread-count`   | Badge number                              | Built     |
| `POST /notifications/read-all`      | Mark all read                             | Built     |
| `PATCH /notifications/:id`          | Mark read / unread                        | Built     |
| `DELETE /notifications/:id`         | Dismiss                                   | Built     |
| `PUT /devices`                      | Register or refresh a device (idempotent) | Not built |
| `DELETE /devices/:token`            | Unregister (sign-out)                     | Not built |
| `GET /devices`                      | List own devices                          | Not built |
| `GET /notifications/preferences`    | Read preferences                          | Not built |
| `PATCH /notifications/preferences`  | Change preferences                        | Not built |
| `PUT /posts/:id/mute`, `DELETE ...` | Mute and unmute a post                    | Not built |

All endpoints require sign-in, are rate-limited, and are documented in the module's OpenAPI file and the SDK.

### 5.2 Data model (new and changed collections; every record carries `communityId`)

| Collection            | Key fields                                                                                                                        | Indexes and lifetime                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `notifications`       | recipientId, type, targetType, targetId, postId, **actors** (last 3 ids), **actorCount**, read, dismissed, lastEventAt, createdAt | (community, recipient, lastEventAt desc); unique group key (recipient, type, target); TTL 90 d |
| `notification_actors` | groupId, actorId, createdAt (the distinct actor set; removed on unlike)                                                           | unique (groupId, actorId); removed with the group                                              |
| `devices`             | memberId, token, platform, appVersion, locale, timezone, status, lastSeenAt                                                       | unique (token); (member); TTL 60 d on lastSeenAt                                               |
| `push_deliveries`     | notificationId, memberId, deviceId, state, sendAfter, attempts, ticketId, error, sentAt                                           | (state, sendAfter); TTL 30 d                                                                   |
| `notification_prefs`  | memberId, per-group booleans, quiet hours (start, end), private                                                                   | unique (member)                                                                                |
| `post_mutes`          | memberId, postId                                                                                                                  | unique (member, post)                                                                          |

### 5.3 Expo Push Service

`POST https://exp.host/--/api/v2/push/send` (up to 100 messages) and `.../push/getReceipts` (up to 1000 ids). Limits in
FR-PSH-6 to FR-PSH-8. The provider is hidden behind a `PushProvider` port (send, receipts) so tests use a fake and the
vendor can be replaced; the notification module never imports the Expo client directly.

---

## 6. Non-functional requirements

### 6.1 Performance

| ID        | Requirement                                                                                                                                                     | Pri | Source   | V   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --- |
| NFR-NPF-1 | `notify()` shall add no more than 30 ms at the 95th percentile to the request that caused it (one indexed write; push planning shall not block it).             | M   | Proposed | T   |
| NFR-NPF-2 | Listing 20 notifications, and the unread count, shall each complete within 200 ms at the 95th percentile with 100,000 notifications per community.              | M   | Proposed | T   |
| NFR-NPF-3 | A push for an urgent event shall reach Expo within 10 seconds of the event at the 95th percentile.                                                              | M   | Proposed | T   |
| NFR-NPF-4 | The sender shall process at least 600 deliveries per second per instance, in batches, without holding more than 5 MB of deliveries in memory.                   | S   | Research | T   |
| NFR-NPF-5 | Every query shall use an index (no collection scans on the inbox, due deliveries, receipts, devices).                                                           | M   | Proposed | I   |
| NFR-NPF-6 | A viral post (10,000 likes in an hour) shall cost one group row update per like and at most one push per liker-window per recipient, not one delivery per like. | M   | Proposed | T   |

### 6.2 Reliability and consistency

| ID        | Requirement                                                                                                                                                                                                                                                          | Pri | Source   | V   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --- |
| NFR-NRL-1 | A failure in notification creation or push shall never fail or roll back the originating action (like, comment, follow, moderation).                                                                                                                                 | M   | Code     | T   |
| NFR-NRL-2 | The system shall send each planned push **at most once** per device under concurrency and restarts (atomic claim); a crash between sending and recording shall be resolved by the receipt check, accepting a rare duplicate over a lost alert for urgent types only. | M   | Proposed | T   |
| NFR-NRL-3 | Group counts shall be eventually consistent with the like records within 1 minute and shall never go negative.                                                                                                                                                       | M   | Proposed | T   |
| NFR-NRL-4 | Group updates shall be one atomic operation per event, so concurrent likes on one post lose no actor and double-count none.                                                                                                                                          | M   | Proposed | T   |
| NFR-NRL-5 | The jobs shall survive Expo or database outages: they shall back off, log, and resume without manual action and without a flood afterwards (FR-NOP-4, FR-NOP-5).                                                                                                     | M   | Proposed | T   |
| NFR-NRL-6 | The push path shall be fully disabled by one environment switch with the inbox unaffected (FR-PSH-14).                                                                                                                                                               | M   | Proposed | T   |
| NFR-NRL-7 | The jobs shall stop gracefully on shutdown, finishing the current batch.                                                                                                                                                                                             | S   | Code     | T   |

### 6.3 Security

| ID        | Requirement                                                                                                                                               | Pri | Source   | V   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --- |
| NFR-NSC-1 | Every notification, device and preference endpoint shall authorise on the server: a member can read and change only their own records.                    | M   | Code     | T   |
| NFR-NSC-2 | Push tokens shall be treated as secrets: never returned to other members, never logged in full (last 6 characters at most), never in error output.        | M   | Proposed | T   |
| NFR-NSC-3 | A token shall be validated by format and bound to one member (FR-DEV-3), so registering someone else's token cannot divert their notifications.           | M   | Proposed | T   |
| NFR-NSC-4 | The Expo access token (enhanced push security) shall live in an environment variable, validated by `config/env.ts`, never in the repository.              | M   | Research | I   |
| NFR-NSC-5 | Notification text shall be built from templates and escaped values; member text shall be treated as data and length-capped (NFR-SEC-3 of SRS v1.5).       | M   | Proposed | T   |
| NFR-NSC-6 | The system shall not allow a member to cause pushes to others beyond FR-NRC-6, and shall rate-limit device registration (20 per hour per member).         | M   | Proposed | T   |
| NFR-NSC-7 | Cross-community tests shall prove that notifications, devices, preferences and mutes of one community are invisible and uncounted in another (NFR-ISO-2). | M   | Proposed | T   |

### 6.4 Privacy and compliance

| ID        | Requirement                                                                                                                                                             | Pri | Source   | V   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --- |
| NFR-NPV-1 | The system shall delete a member's notifications, devices, preferences, mutes and delivery records when their account is deleted (NFR-COMP-3 of SRS v1.5).              | M   | Code     | T   |
| NFR-NPV-2 | The system shall send push content to Expo, Google and Apple only as far as needed to display it, and shall document that these providers receive the title and body.   | M   | Proposed | I   |
| NFR-NPV-3 | The system shall not send a push to a member who has turned that group off, and shall treat an OS-level permission refusal as the member's choice (no re-prompt loops). | M   | Research | D   |
| NFR-NPV-4 | The system shall comply with Google Play and Apple rules on notification permission and user-generated content (NFR-COMP-1).                                            | M   | Proposed | I   |
| NFR-NPV-5 | The system shall keep notification data for no longer than FR-INB-8, FR-DEV-5 and FR-PSH-15, and shall state those periods in the privacy notice.                       | M   | Proposed | I   |

### 6.5 Scalability

| ID        | Requirement                                                                                                                                                | Pri | Source   | V   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --- |
| NFR-NSL-1 | The design shall support 100,000 active members per community and 1,000,000 notifications per day without changing the data model (indexes and TTLs only). | S   | Proposed | A   |
| NFR-NSL-2 | The jobs shall scale horizontally: adding an instance shall increase throughput and shall not cause duplicate sends.                                       | M   | Proposed | T   |
| NFR-NSL-3 | The system shall keep within Expo's 600 messages per second per project by a shared limiter, also when several instances run.                              | M   | Research | T   |
| NFR-NSL-4 | The sender shall be replaceable by a queue worker (for example a separate process) without changing the decision step or data model.                       | C   | Proposed | A   |

### 6.6 Maintainability and observability

| ID        | Requirement                                                                                                                                                                                            | Pri | Source   | V   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------- | --- |
| NFR-NMT-1 | Types, templates, priority classes, caps, windows and quiet-hour rules shall live in one configuration table, changeable without touching service logic.                                               | M   | Proposed | I   |
| NFR-NMT-2 | The push provider shall sit behind a port with a fake for tests; unit tests shall run without network or database.                                                                                     | M   | Proposed | T   |
| NFR-NMT-3 | Each requirement marked **T** shall have an automated test; state transitions shall be covered by table tests (as for other state machines).                                                           | M   | Proposed | T   |
| NFR-NOB-1 | The system shall emit structured logs for each job run and each failure with a request or run id, and never tokens or content.                                                                         | M   | Code     | I   |
| NFR-NOB-2 | The system shall expose the metrics of FR-NOP-3 and shall alert (log at error level) when the failure rate exceeds 20% over 15 minutes or when the oldest `pending` delivery is older than 15 minutes. | S   | Proposed | D   |

### 6.7 Usability and accessibility

| ID        | Requirement                                                                                                                                   | Pri | Source   | V   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --- |
| NFR-NUS-1 | Notification wording shall be short, in the member's language where available (English first), and shall say what happened and to which post. | M   | Research | I   |
| NFR-NUS-2 | Inbox rows shall have accessibility labels that read the full sentence, and unread state shall not rely on colour alone.                      | M   | Proposed | I   |
| NFR-NUS-3 | The settings screen shall explain each switch in one sentence and show the current OS permission state.                                       | S   | Proposed | D   |
| NFR-NUS-4 | Tapping a push shall reach the target in at most one screen transition, also from a cold start.                                               | M   | Proposed | D   |

### 6.8 Cost and portability

| ID        | Requirement                                                                                                                                       | Pri | Source   | V   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | --- |
| NFR-NCP-1 | The subsystem shall run on the existing Node.js, MongoDB and Render setup with no new paid service in this release (Expo's push service is free). | M   | Proposed | I   |
| NFR-NCP-2 | The subsystem shall keep no local disk state, so it runs in a container (NFR-PRT-1).                                                              | M   | Code     | I   |
| NFR-NCP-3 | The coalescing and caps shall be tuned from measured delivery counts, not guessed; defaults are those in this document.                           | S   | Proposed | A   |

---

## 7. Supporting information

### 7.1 Mapping from SRS v1.5

| SRS v1.5  | Replaced by                              |
| --------- | ---------------------------------------- |
| FR-NTF-1  | FR-INB-1, FR-INB-2                       |
| FR-NTF-2  | FR-NEV-1, FR-NEV-2                       |
| FR-NTF-3  | FR-LKE-1 to FR-LKE-6                     |
| FR-NTF-4  | FR-NEV-4                                 |
| FR-NTF-5  | FR-INB-4                                 |
| FR-NTF-6  | FR-INB-3                                 |
| FR-NTF-7  | FR-INB-5                                 |
| FR-NTF-8  | FR-NEV-1, FR-NEV-2 (`review`), FR-NCT-1  |
| FR-NTF-9  | FR-RTR-1 to FR-RTR-6, FR-NEV-5, FR-NEV-6 |
| FR-NTF-10 | Section 3.5 (devices), 3.6 (push)        |

### 7.2 Delivery phases

| Phase | Content                                                                                           | Requirements (main)                                          |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 0     | Correct like/unlike handling and actor-set groups; no UI change. The inbox stays hidden.          | FR-LKE-1 to 6, FR-RTR-1, FR-INB-2, NFR-NRL-3, NFR-NRL-4      |
| 1     | Devices and push for urgent types: sender, receipts, dead-token cleanup, deep links, kill switch. | 3.5, FR-PSH-1, 2, 4 to 15, FR-NOP-1, 2, 4, 5, FR-NCL-2, 4, 5 |
| 2     | Coalescing, caps, preferences, quiet hours, mute, settings screen.                                | FR-PSH-3, 3.7, 3.8, FR-NCL-6, 7                              |
| 3     | New types and staff alerts.                                                                       | FR-NEV-2, 7, 3.9                                             |
| 4     | Retention, metrics, accessibility pass; set `COMMUNITY_NOTIFICATIONS_ENABLED = true` and release. | FR-INB-8, FR-NOP-3, NFR-NUS, FR-NCL-8                        |

### 7.3 Open issues (TBD)

| ID     | Question                                                         | Recommendation                                                                     |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| TBD-N1 | How long to hold like pushes (coalescing window)?                | 3 minutes. Shorter feels instant but sends more; tune from FR-NOP-3 data.          |
| TBD-N2 | Do moderators get push for the queue?                            | Yes, rate-limited (FR-NST-2), off by default for non-staff.                        |
| TBD-N3 | Do quiet hours hold urgent types?                                | No: replies and comments are conversational; offer a "pause all" switch later.     |
| TBD-N4 | Retention of read and dismissed notifications?                   | 90 days, dismissed 7 days.                                                         |
| TBD-N5 | Add an e-mail digest of unseen notifications (as LinkedIn does)? | Later, once an e-mail provider exists; the decision step already allows a channel. |
| TBD-N6 | Show likes as notifications at all, or inbox-only with no push?  | Inbox for all; push for likes only when the group first reaches 1, 5, 25, 100.     |

### 7.4 Verification summary

Unit tests (no database, no network): decision step (priority, preferences, quiet hours, caps, coalescing), group
wording, backoff, batching, transition tables. Integration tests (real middleware, fake `PushProvider`, in-memory
MongoDB): like/unlike/like flapping, concurrent likes, retraction on delete/block/account deletion, device binding and
sign-out, receipt handling with `DeviceNotRegistered`, cross-community leaks, kill switch. Demonstration on a device:
permission prompt, tap-to-open from background and cold start, settings, quiet hours.

---

## 8. References

- `docs/SRS.md` (v1.5): sections 3.2.8 (FR-NTF), NFR-SEC, NFR-COMP, NFR-ISO; `docs/STATE-MACHINES.md`.
- Source reviewed: `src/modules/notifications/*`, `src/core/ports/notifier.ts`, `src/modules/posts/post.service.ts` (`setLike`), `pyqdeck-expo/src/screens/ActivityInboxScreen.tsx`, `src/community/queries.ts`, `src/utils/notifications.ts`.
- LinkedIn Air Traffic Controller (batching, aggregation, frequency control, delayed send, digests): Apache Samza case study, <https://samza.apache.org/case-studies/linkedin>.
- Notification pipeline patterns (preferences, quiet hours, priority tiers, digests): <https://www.techinterview.org/post/3233474155/system-design-notification-system-push-email-sms-in-app-fanout-delivery-tracking-user-preferences-rate-limiting/>.
- Grouped like notifications should sort by the most recent like: <https://meta.discourse.org/t/grouped-liked-notifications-should-sort-by-the-most-recent-like/116489>.
- Expo push service limits (100 messages per request, 600 per second, 4 KiB, receipts after 15 minutes, 1000 ids per receipt call, `DeviceNotRegistered`): <https://docs.expo.dev/push-notifications/sending-notifications>.

## 9. Revision history

| Version | Date       | Change                                                               |
| ------- | ---------- | -------------------------------------------------------------------- |
| 1.0     | 2026-10-19 | First version: current-state review, research, requirements, phases. |
