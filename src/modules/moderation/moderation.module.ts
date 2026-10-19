import type { ContentModerator } from "../../core/ports/content-moderator.js";
import { env } from "../../config/env.js";
import { ModerationEventRepository } from "./moderation-event.repository.js";
import { ModerationPolicy } from "./moderation.policy.js";
import { ModerationService } from "./moderation.service.js";
import type { ModerationProvider } from "./moderation.types.js";
import { NoProfanityFilter, ProfanityFilter, DEFAULT_ALLOWED_WORDS, type ProfanityCheck } from "./profanity.js";
import { OpenAiModerationProvider } from "./providers/openai.provider.js";
import { PassthroughProvider } from "./providers/passthrough.provider.js";

/** Composition root for moderation: the only place that picks the vendor. To change vendor, change this function. */
function createProvider(): ModerationProvider {
  if (!env.OPENAI_API_KEY) return new PassthroughProvider(); // production refuses to start without a key (see env.ts)
  return new OpenAiModerationProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.MODERATION_MODEL,
    timeoutMs: env.MODERATION_TIMEOUT_MS,
  });
}

function createProfanityFilter(): ProfanityCheck {
  if (!env.PROFANITY_FILTER) return new NoProfanityFilter();
  return new ProfanityFilter({
    extraWords: env.PROFANITY_EXTRA_WORDS,
    allowedWords: [...DEFAULT_ALLOWED_WORDS, ...env.PROFANITY_ALLOWED_WORDS],
  });
}

let service: ModerationService | undefined;
export const getModerationService = () =>
  (service ??= new ModerationService(
    createProvider(),
    new ModerationPolicy(),
    new ModerationEventRepository(),
    createProfanityFilter(),
  ));

/** Adapts the moderation service to the small text port that posts, comments and profiles depend on. */
export const getContentModerator = (): ContentModerator => ({
  async moderateText(text, context) {
    const decision = await getModerationService().moderate(
      { text },
      {
        source: context.source,
        sourceId: context.sourceId,
        communityId: context.communityId,
        userId: context.memberId,
      },
    );
    return { action: decision.action, degraded: decision.degraded, categories: decision.categories };
  },
});
