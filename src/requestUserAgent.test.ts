import { describe, expect, it } from "vitest";
import { buildUserAgent, resolveRequestUserAgent } from "./requestUserAgent.js";

describe("request user agent", () => {
  it("builds an antigravity versioned user agent", () => {
    expect(buildUserAgent()).toMatch(/^antigravity\/\d+\.\d+\.\d+ /);
  });

  it("upgrades the bare antigravity marker to a versioned user agent", () => {
    expect(resolveRequestUserAgent("antigravity")).toMatch(/^antigravity\/\d+\.\d+\.\d+ /);
  });

  it("preserves explicit custom user agents", () => {
    expect(resolveRequestUserAgent("custom-agent/9.9")).toBe("custom-agent/9.9");
  });
});
