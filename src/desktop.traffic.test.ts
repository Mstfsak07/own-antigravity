import { describe, expect, it } from "vitest";
import {
  defaultTrafficColumns,
  mergeTrafficColumns,
  normalizeTrafficRecord,
  selectTrafficView
} from "../desktop/ui/traffic.js";

function formatTrafficPayload(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("desktop traffic helpers", () => {
  it("merges traffic columns onto the default schema", () => {
    expect(mergeTrafficColumns({ model: false, route: false })).toMatchObject({
      status: true,
      method: true,
      model: false,
      route: false,
      time: true
    });
    expect(defaultTrafficColumns()).toMatchObject({
      status: true,
      method: true,
      model: true,
      provider: true,
      account: true,
      route: true,
      tokens: true,
      duration: true,
      time: true
    });
  });

  it("filters traffic rows and derives counters from recent requests", () => {
    const metrics = {
      recentRequests: [
        {
          at: "2026-04-27T01:00:00.000Z",
          method: "POST",
          route: "/v1/chat/completions",
          provider: "gemini",
          model: "gemini-2.5-pro",
          account: "A",
          statusCode: 200,
          tokens: { input: 10, output: 15, total: 25 }
        },
        {
          at: "2026-04-27T02:00:00.000Z",
          method: "POST",
          route: "/v1/messages",
          provider: "cloudCode",
          model: "claude-sonnet-4-6",
          account: "B",
          statusCode: 429,
          tokens: { input: 50, output: 10, total: 60 }
        }
      ]
    };

    const view = selectTrafficView(metrics, {
      filter: "claude",
      statusFilter: "error",
      minTokens: 50,
      visibleColumns: { account: false }
    });

    expect(view.filteredRows).toHaveLength(1);
    expect(view.filteredRows[0]).toMatchObject({
      provider: "cloudCode",
      model: "claude-sonnet-4-6",
      statusCode: 429
    });
    expect(view.total).toBe(1);
    expect(view.failed).toBe(1);
    expect(view.success).toBe(0);
    expect(view.visible.some((column: { key: string }) => column.key === "account")).toBe(false);
  });

  it("falls back to recent errors and normalizes detail content", () => {
    const view = selectTrafficView({
      recentErrors: [
        {
          at: "2026-04-27T03:00:00.000Z",
          route: "POST /v1/messages",
          statusCode: 500
        }
      ]
    });

    expect(view.filteredRows[0]).toMatchObject({
      method: "POST",
      provider: "Claude",
      model: "claude-sonnet-4-6",
      statusCode: 500
    });

    const normalized = normalizeTrafficRecord({
      requestBody: {
        messages: [
          { role: "system", content: "be concise" },
          { role: "user", content: "hello" }
        ],
        tools: [{ name: "search" }],
        thinking: { budget: 128 }
      },
      responseBody: {
        choices: [
          {
            message: {
              content: "hi there"
            }
          }
        ]
      }
    }, formatTrafficPayload);

    expect(normalized).toMatchObject({
      system: "be concise",
      prompt: "hello"
    });
    expect(normalized.tools).toContain("search");
    expect(normalized.thinking).toContain("budget");
    expect(normalized.responseSummary).toContain("hi there");
  });
});
