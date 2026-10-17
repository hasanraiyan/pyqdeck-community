import { z } from "zod";
import {
  ModerationInputError,
  ModerationUnavailableError,
  type ModerationImage,
  type ModerationInput,
  type ModerationProvider,
  type ProviderVerdict,
} from "../moderation.types.js";

const resultSchema = z.object({
  flagged: z.boolean(),
  categories: z.record(z.string(), z.boolean()),
  category_scores: z.record(z.string(), z.number()),
});
const responseSchema = z.object({ results: z.array(resultSchema).min(1) });

export interface OpenAiModerationOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Pause before the single retry. */
  retryDelayMs?: number;
}

type ApiInput = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const toDataUrl = (image: { data: Buffer; mimeType: string }) =>
  `data:${image.mimeType};base64,${image.data.toString("base64")}`;

const toApiInput = (input: ModerationInput): ApiInput[] => [
  ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
  ...(input.images ?? []).map((image: ModerationImage) => ({
    type: "image_url" as const,
    image_url: { url: "url" in image ? image.url : toDataUrl(image) },
  })),
];

/** Thin client for POST /v1/moderations (plain fetch, no SDK). The API key never appears in an error message. */
export class OpenAiModerationProvider implements ModerationProvider {
  readonly name = "openai";

  constructor(private readonly options: OpenAiModerationOptions) {}

  async moderate(input: ModerationInput): Promise<ProviderVerdict> {
    const body = JSON.stringify({ model: this.options.model, input: toApiInput(input) });

    // One retry for rate limits, server errors and network blips. Anything else will not get better by waiting.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(body);
      } catch (err) {
        const retryable = err instanceof ModerationUnavailableError && (err as RetryableError).retryable === true;
        if (!retryable || attempt >= 1) throw err;
        await new Promise((r) => setTimeout(r, this.options.retryDelayMs ?? 300));
      }
    }
  }

  private async send(body: string): Promise<ProviderVerdict> {
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.baseUrl ?? "https://api.openai.com"}/v1/moderations`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      throw retryable("Could not reach the moderation service");
    }

    if (response.status === 429 || response.status >= 500)
      throw retryable(`Moderation service returned ${response.status}`);
    // 401/403 mean our credentials or account are wrong: not retryable, and everything fails closed until fixed.
    if (response.status === 401 || response.status === 403) {
      throw new ModerationUnavailableError(`Moderation credentials were rejected (${response.status})`);
    }
    // 400: the input itself is unusable (corrupt or unsupported image, unreachable image URL).
    if (response.status === 400) throw new ModerationInputError("The moderation service could not read the content");
    if (!response.ok) throw new ModerationUnavailableError(`Unexpected moderation response ${response.status}`);

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ModerationUnavailableError("Moderation response was not valid JSON");
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new ModerationUnavailableError("Moderation response had an unexpected shape");

    return mergeResults(parsed.data.results);
  }
}

type RetryableError = ModerationUnavailableError & { retryable?: boolean };
function retryable(message: string): ModerationUnavailableError {
  const err: RetryableError = new ModerationUnavailableError(message);
  err.retryable = true;
  return err;
}

/** Several inputs can come back as several results; the worst of each category is what matters. */
function mergeResults(results: z.infer<typeof resultSchema>[]): ProviderVerdict {
  const verdict: ProviderVerdict = { flagged: false, categories: {}, scores: {} };
  for (const r of results) {
    verdict.flagged ||= r.flagged;
    for (const [category, flagged] of Object.entries(r.categories)) {
      verdict.categories[category] = verdict.categories[category] || flagged;
    }
    for (const [category, score] of Object.entries(r.category_scores)) {
      verdict.scores[category] = Math.max(verdict.scores[category] ?? 0, score);
    }
  }
  return verdict;
}
