import { describe, expect, it } from "vitest";
import { ApiKeyPool } from "./keyPool.js";

describe("ApiKeyPool", () => {
  it("rotates keys in order", () => {
    const pool = new ApiKeyPool(["a", "b"]);

    expect(pool.next()?.value).toBe("a");
    expect(pool.next()?.value).toBe("b");
    expect(pool.next()?.value).toBe("a");
  });

  it("returns undefined when empty", () => {
    const pool = new ApiKeyPool([]);

    expect(pool.hasKeys()).toBe(false);
    expect(pool.next()).toBeUndefined();
    expect(pool.size()).toBe(0);
  });

  it("quarantines failed keys until retry time", () => {
    const pool = new ApiKeyPool(["a"], 300);
    const lease = pool.next();

    expect(lease?.value).toBe("a");
    pool.reportFailure(lease!.id, "auth_error");

    expect(pool.next()).toBeUndefined();
    expect(pool.snapshot()[0]).toMatchObject({
      healthy: false,
      consecutiveFailures: 1,
      disabledReason: "auth_error"
    });
  });
});
