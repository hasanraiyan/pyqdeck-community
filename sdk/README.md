# @pyqdeck/community-sdk

Typed client for the PYQDeck Community API. It works in React Native (Expo, Hermes) and the browser. It has **no cache,
no Clerk and no React inside**: your app passes a `getToken()` function and owns caching, retries and optimistic updates
(for example with TanStack Query).

```ts
import { createCommunityClient, communityKeys } from "@pyqdeck/community-sdk";

const community = createCommunityClient({
  baseUrl: "https://community-api.pyqdeck.in",
  community: "beu", // one client per community
  getToken: async () => (await clerk.session?.getToken()) ?? null,
});

// Read
const feed = await community.posts.feed({ hashtag: "dsa", limit: 20 }); // { items, nextCursor, hasMore }
const next = await community.posts.feed({ cursor: feed.nextCursor! });

// Publish with images in one call (upload, check, create), with progress and cancel
const post = await community.publishPost({
  body: "Dijkstra notes #dsa",
  images: [{ uri, mimeType: "image/jpeg", size }],
  onProgress: (p) => setProgress(p), // 0..1
  signal: controller.signal,
});

// React with TanStack Query: keys always start with the community
useQuery({
  queryKey: communityKeys.feed("beu", { hashtag: "dsa" }),
  queryFn: ({ signal }) => community.posts.feed({ hashtag: "dsa" }, { signal }),
});
```

## Errors

Every failure is a `CommunityApiError` with `status` (0 means no answer from the server), a stable `code`
(`not_found`, `unauthorized`, `too_many_requests`, `unprocessable_entity`, `network_error`, `timeout`, `aborted`),
`retryAfterMs` for rate limits, and `requestId` to quote in bug reports. `message` is safe to show to students.

## Good to know

- Every method takes `{ signal }` as its last argument.
- Responses contain only JSON-safe values (dates are ISO strings), so they can be persisted.
- Send an idempotency key (`publishPost` does this for you) so a retry after a timeout never creates a duplicate.
- The API surface lives at `/api/v1`. A breaking API change means a new major version of this package.

## License

MIT
