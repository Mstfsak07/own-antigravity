import { describe, expect, it } from "vitest";
import { diagnoseAccount } from "./accountDiagnosis.js";
import type { StoredAccount } from "./types.js";

function baseAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "acct-1",
    email: "person@example.test",
    supportedModels: [],
    source: "oauth_login",
    health: {
      healthy: true,
      consecutiveFailures: 0
    },
    ...overrides
  };
}

describe("account diagnosis", () => {
  it("flags expired oauth accounts as auth problems with recovery steps", () => {
    const diagnosis = diagnoseAccount(baseAccount({
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      health: {
        healthy: true,
        consecutiveFailures: 2,
        disabledReason: "provider_error"
      }
    }));

    expect(diagnosis).toMatchObject({
      isProblem: true,
      kind: "auth_expired",
      canDisable: true,
      disableReason: "manual:auth_error"
    });
    expect(diagnosis.steps.join("\n")).toContain("Uygulamada hesabı kaldırıp yeniden OAuth ile ekle.");
    expect(diagnosis.steps.join("\n")).toContain("Bu hesap `gcloud auth list` içinde görünüyorsa");
  });

  it("flags future-token 500 accounts as upstream failures", () => {
    const diagnosis = diagnoseAccount(baseAccount({
      source: "imported_json",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      health: {
        healthy: true,
        consecutiveFailures: 5,
        disabledReason: "http_500"
      }
    }));

    expect(diagnosis).toMatchObject({
      isProblem: true,
      kind: "provider_failure",
      canDisable: true,
      disableReason: "manual:http_500"
    });
  });
});
