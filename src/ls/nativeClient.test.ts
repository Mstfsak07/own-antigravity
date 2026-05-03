import { describe, expect, it } from "vitest";
import { NativeLsClient } from "./nativeClient.js";
import { LsRequestTimeout } from "./errors.js";
import type { CloudCodeAccount } from "../types.js";

function account(): CloudCodeAccount {
  return {
    id: "a",
    filePath: "",
    source: "imported_json",
    accessToken: "token",
    disabled: false,
    health: { healthy: true, consecutiveFailures: 0 },
    quotaModels: []
  };
}

describe("NativeLsClient", () => {
  it("maps request timeout", async () => {
    const orchestrator = {
      async startOrReuse() {
        return { id: "i", accountId: "a", status: "running" };
      },
      async send(_id: string, _request: unknown, signal?: AbortSignal) {
        await new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(resolve, 50);
        });
        return { raw: "late" };
      }
    };
    const client = new NativeLsClient(orchestrator as any, async () => account(), 1);

    await expect(client.request("m", "openai", {})).rejects.toBeInstanceOf(LsRequestTimeout);
  });
});
