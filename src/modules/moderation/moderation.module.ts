import { env } from "../../config/env.js";
import { ModerationEventRepository } from "./moderation-event.repository.js";
import { ModerationPolicy } from "./moderation.policy.js";
import { ModerationService } from "./moderation.service.js";
import type { ModerationProvider } from "./moderation.types.js";
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

let service: ModerationService | undefined;
export const getModerationService = () =>
  (service ??= new ModerationService(createProvider(), new ModerationPolicy(), new ModerationEventRepository()));
