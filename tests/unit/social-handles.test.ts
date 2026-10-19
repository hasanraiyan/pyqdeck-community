import { describe, expect, it } from "vitest";
import { extractSocialHandle, updateMemberSchema } from "../../src/modules/members/member.schema.js";

describe("extractSocialHandle", () => {
  it("reads the handle from the link people actually paste", () => {
    expect(extractSocialHandle("twitter", "https://x.com/_RaiyanHasan")).toBe("_RaiyanHasan");
    expect(extractSocialHandle("twitter", "https://twitter.com/jack?lang=en")).toBe("jack");
    expect(extractSocialHandle("twitter", "x.com/jack/")).toBe("jack");
    expect(extractSocialHandle("github", "https://github.com/hasanraiyan/pyqdeck-community")).toBe("hasanraiyan");
    expect(extractSocialHandle("linkedin", "https://www.linkedin.com/in/raiyan-hasan-123/")).toBe("raiyan-hasan-123");
  });

  it("still accepts a plain handle, with or without @", () => {
    expect(extractSocialHandle("twitter", "@_RaiyanHasan")).toBe("_RaiyanHasan");
    expect(extractSocialHandle("github", "hasanraiyan")).toBe("hasanraiyan");
    expect(extractSocialHandle("twitter", "")).toBe("");
    expect(extractSocialHandle("twitter", "   ")).toBe("");
  });

  it("refuses a link to another site, another scheme or a page that is not a profile", () => {
    expect(extractSocialHandle("twitter", "https://evil.example/jack")).toBeNull();
    expect(extractSocialHandle("twitter", "https://x.com.evil.example/jack")).toBeNull();
    expect(extractSocialHandle("twitter", "javascript:alert(1)")).toBeNull();
    expect(extractSocialHandle("twitter", "ftp://x.com/jack")).toBeNull();
    expect(extractSocialHandle("linkedin", "https://www.linkedin.com/company/acme")).toBeNull();
    expect(extractSocialHandle("github", "https://github.com/")).toBeNull();
  });
});

describe("updateMemberSchema social fields", () => {
  const parse = (body: object) => updateMemberSchema.safeParse(body);

  it("stores only the handle, even when a link was pasted", () => {
    const result = parse({ twitter: "https://x.com/_RaiyanHasan", github: "https://github.com/hasanraiyan" });
    expect(result.success && result.data).toMatchObject({ twitter: "_RaiyanHasan", github: "hasanraiyan" });
  });

  it("lets a field be cleared", () => {
    const result = parse({ twitter: "" });
    expect(result.success && result.data).toMatchObject({ twitter: "" });
  });

  it("explains what to enter when the value is wrong", () => {
    for (const body of [
      { twitter: "not a handle!" },
      { twitter: "waytoolonghandlethatexceeds15" },
      { twitter: "https://evil.example/jack" },
      { linkedin: "https://github.com/jack" },
    ]) {
      const result = parse(body);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toMatch(/username or profile link/);
    }
  });
});

describe("updateMemberSchema website", () => {
  const website = (value: string) => {
    const result = updateMemberSchema.safeParse({ website: value });
    return result.success ? result.data.website : null;
  };

  it("adds https:// to a bare domain and keeps a full https link", () => {
    expect(website("pyqdeck.in")).toBe("https://pyqdeck.in");
    expect(website("https://raiyan.dev/me")).toBe("https://raiyan.dev/me");
    expect(website("")).toBe("");
  });

  it("refuses other schemes", () => {
    expect(website("http://example.com")).toBeNull();
    expect(website("javascript:alert(1)")).toBeNull();
    expect(website("ftp://example.com")).toBeNull();
  });
});
