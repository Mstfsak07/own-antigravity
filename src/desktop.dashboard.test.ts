import { describe, expect, it } from "vitest";
import {
  activityView,
  auditTrailView,
  collectWarnings,
  dashboardOverviewView,
  healthSnapshotView,
  modelQuotaEntries,
  providerBadgeView
} from "../desktop/ui/dashboardView.js";

describe("desktop dashboard selectors", () => {
  it("aggregates model quotas and picks the best account per model", () => {
    const entries = modelQuotaEntries([
      {
        email: "a@example.com",
        quota: [{ name: "claude-sonnet-4-6", percentage: 40, resetTime: "2026-04-28T00:00:00.000Z" }]
      },
      {
        email: "b@example.com",
        quota: [{ name: "claude-sonnet-4-6", percentage: 90, resetTime: "2026-04-27T12:00:00.000Z" }]
      }
    ]);

    expect(entries[0]).toMatchObject({
      name: "claude-sonnet-4-6",
      provider: "Claude",
      bestPercent: 90,
      bestAccount: "b@example.com",
      accounts: 2
    });
  });

  it("builds health snapshot warnings and problem accounts", () => {
    const nextRetryAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const snapshot = healthSnapshotView({
      health: {
        providers: {
          gemini: { active: true, keyCount: 2 },
          anthropic: { active: false, keyCount: 0 },
          cloudCode: { active: true, healthyCount: 1, unhealthyCount: 1 }
        },
        ls: { enabled: true, activeInstances: 3, nativeEnabled: true, providerFallback: true }
      },
      summary: { lowQuotaWarnings: ["manual warning"] },
      accounts: [
        {
          email: "low@example.com",
          source: "oauth_login",
          quota: [{ name: "gemini-2.5-pro", percentage: 10 }],
          health: { healthy: true, nextRetryAt }
        },
        {
          email: "empty@example.com",
          source: "imported_json",
          quota: [],
          health: { healthy: false }
        }
      ],
      accountHealth: { accounts: [] },
      adminStatus: { status: "ok", port: 8046 }
    });

    expect(snapshot.providerCards).toHaveLength(5);
    expect(snapshot.warnings).toContain("manual warning");
    expect(snapshot.warnings.some((warning) => warning.includes("low@example.com"))).toBe(true);
    expect(snapshot.warnings.some((warning) => warning.includes("empty@example.com için kota bilgisi yok"))).toBe(true);
    expect(snapshot.problemAccounts).toHaveLength(2);
    expect(snapshot.problemAccounts[0]).toMatchObject({
      source: "oauth_login"
    });
  });

  it("builds overview, badges, activity, audit, and warning summaries", () => {
    const overview = dashboardOverviewView({
      health: { providers: { gemini: true, cloudCode: false } },
      summary: { totalAccounts: 4, healthyAccounts: 3, activeAccountId: "acct-1" },
      metrics: { uptimeSeconds: 125 }
    });

    expect(overview.active).toBe("acct-1");
    expect(overview.cards.slice(0, 2)).toEqual([
      ["T", "Total Accounts", 4],
      ["H", "Healthy Accounts", 3]
    ]);

    expect(providerBadgeView({
      providers: { gemini: { active: true }, anthropic: { active: false }, cloudCode: { active: true } },
      ls: { enabled: true }
    }).slice(0, 2)).toEqual([
      ["Gemini", true],
      ["Claude", true]
    ]);

    expect(activityView({ recentErrors: [] })[0]).toMatchObject({
      badge: "healthy"
    });
    expect(activityView({ recentErrors: [{ route: "POST /v1/messages", statusCode: 500 }] })[0].text).toContain("500");

    const audit = auditTrailView({
      auditTrail: [{ provider: "gemini", model: "gemini-2.5-pro", route: "/v1/chat/completions", statusCode: 200 }]
    });
    expect(audit[0]).toMatchObject({
      tone: "healthy",
      title: "gemini · gemini-2.5-pro"
    });

    expect(collectWarnings([
      {
        email: "warn@example.com",
        quota: [{ name: "gemini-2.5-pro", percentage: 15 }],
        health: { healthy: false }
      }
    ], ["seed"])).toEqual(expect.arrayContaining(["seed", "warn@example.com karantinada"]));
  });
});
