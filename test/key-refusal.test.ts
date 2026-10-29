import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxyError } from "../src/errors.js";
import {
  isKeyRefusal,
  recentKeyRefusal,
  rememberKeyRefusal,
  resetKeyRefusals,
} from "../src/clients/key-refusal.js";

const URL_A = "https://upstream.invalid/mcp";

describe("key refusal memory", () => {
  afterEach(() => {
    resetKeyRefusals();
    vi.useRealTimers();
  });

  it.each([
    { category: "auth", expected: true },
    { category: "rate_limited", expected: true },
    { category: "upstream", expected: false },
    { category: "configuration", expected: false },
  ] as const)("classifies a $category error as a refusal: $expected", ({ category, expected }) => {
    expect(isKeyRefusal(new ProxyError(category))).toBe(expected);
  });

  it("does not classify other values as a refusal", () => {
    expect(isKeyRefusal(new Error("boom"))).toBe(false);
    expect(isKeyRefusal(undefined)).toBe(false);
  });

  it("returns the remembered problem only for the same server and key", () => {
    const problem = new ProxyError("auth");
    rememberKeyRefusal(URL_A, "key-1", problem);

    expect(recentKeyRefusal(URL_A, "key-1")).toBe(problem);
    expect(recentKeyRefusal(URL_A, "key-2")).toBeUndefined();
    expect(recentKeyRefusal(URL_A, undefined)).toBeUndefined();
    expect(recentKeyRefusal("https://other.invalid/mcp", "key-1")).toBeUndefined();
  });

  it("remembers a refusal without a key", () => {
    const problem = new ProxyError("auth");
    rememberKeyRefusal(URL_A, undefined, problem);

    expect(recentKeyRefusal(URL_A, undefined)).toBe(problem);
    expect(recentKeyRefusal(URL_A, "key-1")).toBeUndefined();
  });

  it("forgets a refusal after one minute", () => {
    vi.useFakeTimers();
    rememberKeyRefusal(URL_A, "key-1", new ProxyError("auth"));

    vi.advanceTimersByTime(59_999);
    expect(recentKeyRefusal(URL_A, "key-1")).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(recentKeyRefusal(URL_A, "key-1")).toBeUndefined();
  });
});
