import { describe, expect, it } from "vitest";
import {
  UrlRejected,
  extractUrls,
  findForbiddenScheme,
  hostMatches,
  isLookalikeHost,
  maskNonProse,
  normalizeUrl,
} from "../../src/modules/links/url-tools.js";

const urls = (text: string) => extractUrls(text).map((s) => s.raw);
const rejection = (raw: string) => {
  try {
    normalizeUrl(raw);
  } catch (err) {
    return err instanceof UrlRejected ? err.reason : "other";
  }
  return null;
};

describe("extractUrls", () => {
  it("finds bare URLs, Markdown destinations and autolinks, trimming trailing punctuation", () => {
    expect(
      urls("see https://a.example/x, and (https://b.example/y). Also [t](https://c.example/z) <https://d.example>!"),
    ).toEqual(["https://a.example/x", "https://b.example/y", "https://c.example/z", "https://d.example"]);
  });

  it("reports exact positions so text can be substituted", () => {
    const text = "go https://a.example/x now";
    const [span] = extractUrls(text);
    expect(text.slice(span.start, span.end)).toBe("https://a.example/x");
  });

  it("ignores code spans, fenced blocks and LaTeX math", () => {
    const text =
      "`https://a.example` ```\nhttps://b.example\n``` $$ https://c.example $$ $x=https://d.example$ https://real.example";
    expect(urls(text)).toEqual(["https://real.example"]);
  });

  it("does not mistake currency for math", () => {
    expect(urls("costs $5 and $10 see https://a.example")).toEqual(["https://a.example"]);
  });

  it("keeps bracketed IPv6 hosts", () => {
    expect(urls("http://[::1]/x")).toEqual(["http://[::1]/x"]);
  });

  it("treats an unterminated fence as code", () => {
    expect(maskNonProse("```\nhttps://a.example")).not.toContain("https");
  });
});

describe("findForbiddenScheme", () => {
  it.each([
    "[x](javascript:alert(1))",
    "[x](data:text/html,hi)",
    "<file:///etc/passwd>",
    "[x]( vbscript:x)",
    "[x](intent://a)",
  ])("flags %s", (text) => expect(findForbiddenScheme(text)).not.toBeNull());

  it("allows http(s) and plain text that merely mentions a scheme", () => {
    expect(findForbiddenScheme("[x](https://a.example) and the word javascript: in prose")).toBeNull();
    expect(findForbiddenScheme("`[x](javascript:1)`")).toBeNull(); // inside code
  });
});

describe("normalizeUrl", () => {
  it("lower-cases scheme and host, drops default ports and trailing dots", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/Path?Q=1#F")).toEqual({
      href: "https://example.com/Path?Q=1#F",
      host: "example.com",
    });
    expect(normalizeUrl("http://example.com:80/").href).toBe("http://example.com/");
    expect(normalizeUrl("https://example.com./x").host).toBe("example.com");
  });

  it("converts an internationalised host to punycode", () => {
    expect(normalizeUrl("https://bücher.example/x").host).toBe("xn--bcher-kva.example");
  });

  it.each([
    ["javascript:alert(1)", "bad_scheme"],
    ["ftp://example.com/x", "bad_scheme"],
    ["https://u:p@example.com/", "credentials"],
    ["https://localhost/", "internal_host"],
    ["http://127.0.0.1/", "internal_host"],
    ["http://10.1.2.3/", "internal_host"],
    ["http://172.16.0.1/", "internal_host"],
    ["http://192.168.0.1/", "internal_host"],
    ["http://169.254.169.254/", "internal_host"],
    ["http://100.64.0.1/", "internal_host"],
    ["http://0.0.0.0/", "internal_host"],
    ["http://2130706433/", "internal_host"],
    ["http://0x7f.0.0.1/", "internal_host"],
    ["http://[::1]/", "internal_host"],
    ["http://[fe80::1]/", "internal_host"],
    ["http://[::ffff:127.0.0.1]/", "internal_host"],
    ["http://printer.local/", "internal_host"],
    ["http://intranet/", "internal_host"],
    ["not a url", "invalid"],
  ])("rejects %s (%s)", (raw, reason) => expect(rejection(raw)).toBe(reason));

  it("rejects over-long URLs and accepts public addresses", () => {
    expect(rejection(`https://example.com/${"a".repeat(2100)}`)).toBe("too_long");
    expect(rejection("http://93.184.216.34/")).toBeNull();
    expect(rejection("http://172.32.0.1/")).toBeNull(); // just outside 172.16/12
  });
});

describe("hostMatches / isLookalikeHost", () => {
  it("matches a domain and its subdomains only", () => {
    expect(hostMatches("pyqdeck.in", "pyqdeck.in")).toBe(true);
    expect(hostMatches("www.pyqdeck.in", "pyqdeck.in")).toBe(true);
    expect(hostMatches("evilpyqdeck.in", "pyqdeck.in")).toBe(false);
    expect(hostMatches("pyqdeck.in.evil.com", "pyqdeck.in")).toBe(false);
  });

  it("flags punycode labels", () => {
    expect(isLookalikeHost("xn--pple-43d.com")).toBe(true);
    expect(isLookalikeHost("apple.com")).toBe(false);
  });
});
