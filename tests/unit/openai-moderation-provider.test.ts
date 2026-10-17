import { describe, expect, it, vi } from "vitest";
import { ModerationInputError, ModerationUnavailableError } from "../../src/modules/moderation/moderation.types.js";
import { OpenAiModerationProvider } from "../../src/modules/moderation/providers/openai.provider.js";

const API_KEY = "sk-test-super-secret-key";

const ok = (results: unknown[]) =>
  new Response(JSON.stringify({ id: "modr-1", model: "omni-moderation-latest", results }), { status: 200 });

const result = (flagged: string[] = [], scores: Record<string, number> = {}) => ({
  flagged: flagged.length > 0,
  categories: {
    ...Object.fromEntries(Object.keys(scores).map((c) => [c, false])),
    ...Object.fromEntries(flagged.map((c) => [c, true])),
  },
  category_scores: scores,
});

const make = (fetchImpl: typeof fetch) =>
  new OpenAiModerationProvider({
    apiKey: API_KEY,
    model: "omni-moderation-latest",
    timeoutMs: 5000,
    fetchImpl,
    retryDelayMs: 0,
  });

const fetchReturning = (...responses: Array<Response | Error>) => {
  const queue = [...responses];
  const fn = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    if (next instanceof Error) throw next;
    return next;
  });
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};

describe("request", () => {
  it("posts to the moderation endpoint with a bearer key, the model, and text plus images", async () => {
    const fetchMock = fetchReturning(ok([result()]));
    await make(fetchMock).moderate({
      text: "hello",
      images: [{ url: "https://img.test/a.png" }, { data: Buffer.from("abc"), mimeType: "image/png" }],
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/moderations");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "omni-moderation-latest",
      input: [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "https://img.test/a.png" } },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("abc").toString("base64")}` } },
      ],
    });
  });

  it("omits the text entry when only images are given", async () => {
    const fetchMock = fetchReturning(ok([result()]));
    await make(fetchMock).moderate({ images: [{ url: "https://img.test/a.png" }] });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.input).toHaveLength(1);
    expect(body.input[0].type).toBe("image_url");
  });
});

describe("response", () => {
  it("returns the provider's categories and scores", async () => {
    const verdict = await make(fetchReturning(ok([result(["sexual"], { sexual: 0.97, hate: 0.01 })]))).moderate({
      text: "x",
    });
    expect(verdict).toEqual({
      flagged: true,
      categories: { sexual: true, hate: false },
      scores: { sexual: 0.97, hate: 0.01 },
    });
  });

  it("merges several results: any flag wins and the highest score is kept", async () => {
    const verdict = await make(
      fetchReturning(ok([result([], { sexual: 0.2, hate: 0.9 }), result(["sexual"], { sexual: 0.8, hate: 0.1 })])),
    ).moderate({ text: "x" });

    expect(verdict.flagged).toBe(true);
    expect(verdict.categories.sexual).toBe(true);
    expect(verdict.scores).toEqual({ sexual: 0.8, hate: 0.9 });
  });
});

describe("failure handling", () => {
  it("retries once after a 429 and then succeeds", async () => {
    const fetchMock = fetchReturning(new Response("slow down", { status: 429 }), ok([result()]));
    await expect(make(fetchMock).moderate({ text: "x" })).resolves.toMatchObject({ flagged: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once after a 5xx and then gives up as unavailable", async () => {
    const fetchMock = fetchReturning(new Response("", { status: 503 }), new Response("", { status: 500 }));
    await expect(make(fetchMock).moderate({ text: "x" })).rejects.toBeInstanceOf(ModerationUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a network failure or timeout as unavailable, after one retry", async () => {
    const fetchMock = fetchReturning(
      new TypeError("fetch failed"),
      new Error("The operation was aborted due to timeout"),
    );
    await expect(make(fetchMock).moderate({ text: "x" })).rejects.toBeInstanceOf(ModerationUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("does not retry a %i, and reports unavailable (fail closed)", async (status) => {
    const fetchMock = fetchReturning(new Response("nope", { status }));
    await expect(make(fetchMock).moderate({ text: "x" })).rejects.toBeInstanceOf(ModerationUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports unreadable input (400) as an input error, without retrying", async () => {
    const fetchMock = fetchReturning(new Response("bad image", { status: 400 }));
    await expect(make(fetchMock).moderate({ images: [{ url: "https://img.test/broken" }] })).rejects.toBeInstanceOf(
      ModerationInputError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-JSON", new Response("<html>oops</html>", { status: 200 })],
    ["an unexpected shape", new Response(JSON.stringify({ results: [] }), { status: 200 })],
    ["missing fields", new Response(JSON.stringify({ results: [{ flagged: true }] }), { status: 200 })],
  ])("treats %s as unavailable rather than guessing", async (_label, response) => {
    await expect(make(fetchReturning(response)).moderate({ text: "x" })).rejects.toBeInstanceOf(
      ModerationUnavailableError,
    );
  });

  it("never puts the API key in an error message", async () => {
    const attempts = [
      fetchReturning(new Response("", { status: 401 })),
      fetchReturning(new Response("", { status: 500 }), new Response("", { status: 500 })),
      fetchReturning(new TypeError(`fetch failed for key ${API_KEY}`), new TypeError("again")),
    ];
    for (const fetchMock of attempts) {
      const err = await make(fetchMock)
        .moderate({ text: "x" })
        .then(
          () => {
            throw new Error("expected the call to fail");
          },
          (e: Error) => e,
        );
      expect(err.message).not.toContain(API_KEY);
    }
  });
});
