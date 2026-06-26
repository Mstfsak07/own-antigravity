import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Metrics } from "./metrics.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "own-ag-metrics-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Metrics", () => {
  it("loads recent history from gzipped archives", () => {
    const dir = makeDir();
    const archivePath = join(dir, "traffic-log-20260426T120000.jsonl.gz");
    writeFileSync(
      archivePath,
      gzipSync(
        [
          JSON.stringify({
            at: "2026-04-26T10:00:00.000Z",
            method: "POST",
            route: "/v1/messages",
            provider: "claude",
            model: "claude-sonnet-4-6",
            statusCode: 200
          }),
          JSON.stringify({
            at: "2026-04-26T10:01:00.000Z",
            method: "POST",
            route: "/v1/chat/completions",
            provider: "gemini",
            model: "gemini-2.5-pro",
            statusCode: 403
          })
        ].join("\n")
      )
    );

    const metrics = new Metrics(dir);
    const snapshot = metrics.snapshot();

    expect(snapshot.recentRequests).toHaveLength(2);
    expect(snapshot.recentRequests[0]).toMatchObject({
      route: "/v1/chat/completions",
      statusCode: 403
    });
    expect(snapshot.recentRequests[1]).toMatchObject({
      route: "/v1/messages",
      statusCode: 200
    });
  });

  it("rotates oversized traffic and audit logs into gzip archives", () => {
    const dir = makeDir();
    const trafficPath = join(dir, "traffic-log.jsonl");
    const auditPath = join(dir, "audit-log.jsonl");
    writeFileSync(trafficPath, "x".repeat(5 * 1024 * 1024 + 128), "utf8");
    writeFileSync(auditPath, "y".repeat(5 * 1024 * 1024 + 128), "utf8");

    const metrics = new Metrics(dir);
    metrics.recordTraffic({
      at: "2026-04-26T10:05:00.000Z",
      actor: "tester@example.com",
      event: "request",
      method: "POST",
      route: "/v1/messages",
      provider: "cloudCode",
      model: "claude-sonnet-4-6",
      account: "tester@example.com",
      statusCode: 200,
      tokens: { input: 12, output: 34, total: 46 },
      requestBody: { hello: "world" },
      responseBody: { ok: true }
    });

    const files = new Set(readdirSync(dir));
    expect([...files].some((name) => /^traffic-log-\d{8}T\d{6}\.jsonl\.gz$/.test(name))).toBe(true);
    expect([...files].some((name) => /^audit-log-\d{8}T\d{6}\.jsonl\.gz$/.test(name))).toBe(true);
    expect(readFileSync(trafficPath, "utf8")).toBe("");
    expect(readFileSync(auditPath, "utf8")).toBe("");
    expect(existsSync(trafficPath)).toBe(true);
    expect(existsSync(auditPath)).toBe(true);
  });

  it("normalizes provider traffic records with derived event, duration, and tokens", () => {
    const dir = makeDir();
    const metrics = new Metrics(dir);
    const startedAt = Date.now() - 75;

    const record = metrics.recordProviderTraffic({
      actor: "Gemini API key",
      method: "POST",
      route: "/v1/chat/completions",
      provider: "gemini",
      resolvedModel: "gemini-2.5-pro",
      statusCode: 429,
      startedAt,
      requestBody: { prompt: "hello" },
      errorBody: { error: "rate_limit" }
    });

    expect(record).toMatchObject({
      actor: "Gemini API key",
      event: "error",
      provider: "gemini",
      model: "gemini-2.5-pro",
      resolvedModel: "gemini-2.5-pro",
      statusCode: 429
    });
    expect(record.durationMs).toBeGreaterThanOrEqual(50);
    expect(record.tokens?.total).toBeGreaterThan(0);

    const snapshot = metrics.snapshot();
    expect(snapshot.recentRequests[0]).toMatchObject({
      event: "error",
      provider: "gemini",
      route: "/v1/chat/completions"
    });
    expect(snapshot.auditTrail[0]).toMatchObject({
      actor: "Gemini API key",
      provider: "gemini",
      statusCode: 429
    });
  });

  it("compacts large provider payloads before keeping them in traffic history", () => {
    const dir = makeDir();
    const metrics = new Metrics(dir);
    const largeText = "x".repeat(20_000);

    const record = metrics.recordProviderTraffic({
      method: "POST",
      route: "/v1/messages",
      provider: "cloudCode",
      model: "claude-sonnet-4-6",
      statusCode: 500,
      requestBody: { image: largeText },
      errorBody: { error: "internal" }
    });

    expect(JSON.stringify(record.requestBody).length).toBeLessThan(13_000);
    expect(JSON.stringify(metrics.snapshot().recentRequests[0].requestBody).length).toBeLessThan(13_000);
  });
});
