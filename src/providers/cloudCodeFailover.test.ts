import { beforeEach, describe, expect, it, vi } from "vitest";
import { callCloudCodeWithFailover } from "./cloudCodeFailover.js";
import type { Runtime } from "../runtime.js";

const callCloudCodeMock = vi.hoisted(() => vi.fn());

vi.mock("../cloudCode/client.js", () => ({
  callCloudCode: callCloudCodeMock
}));

function runtimeStub(): Runtime {
  const account = {
    id: "acc-1",
    email: "a@example.test",
    accessToken: "token",
    refreshToken: "refresh",
    projectId: "project-1",
    quotaModels: [{ name: "gemini-2.5-pro", percentage: 100 }],
    disabled: false,
    health: { healthy: true, consecutiveFailures: 0 }
  } as any;

  return {
    config: {
      cloudCode: {
        baseUrls: ["https://cloudcode-pa.googleapis.com/v1internal"],
        userAgent: "test",
        sendUserProjectHeader: false,
        quarantineSeconds: 300,
        preserveAvailabilityOnError: true,
        refreshSkewSeconds: 120
      }
    } as any,
    metrics: {
      setActiveProvider: vi.fn(),
      recordProviderRequest: vi.fn()
    } as any,
    cloudCodeAccounts: {
      select: vi.fn().mockResolvedValue(account),
      reportFailure: vi.fn(),
      noteModelFailure: vi.fn(),
      reportSuccess: vi.fn(),
      noteModelSuccess: vi.fn(),
      reportStatusFailure: vi.fn(),
      refresh: vi.fn().mockResolvedValue(account)
    } as any
  } as Runtime;
}

describe("callCloudCodeWithFailover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries without project when Cloud Code rejects project context licensing", async () => {
    callCloudCodeMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 500,
              message: "You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)"
            }
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }]
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );

    const runtime = runtimeStub();
    const result = await callCloudCodeWithFailover({
      runtime,
      model: "gemini-2.5-pro",
      method: "generateContent",
      buildBody: () => ({
        requestId: "agent-test",
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        model: "gemini-2.5-pro",
        userAgent: "test",
        requestType: "generate-content",
        project: "project-1"
      })
    });

    expect(result.ok).toBe(true);
    expect(callCloudCodeMock).toHaveBeenCalledTimes(2);
    expect(callCloudCodeMock.mock.calls[0][3].project).toBe("project-1");
    expect(callCloudCodeMock.mock.calls[1][3].project).toBeUndefined();
  });

  it("falls back to a recovery Gemini model after retryable upstream failures", async () => {
    callCloudCodeMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 500, message: "internal" } }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }]
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );

    const runtime = runtimeStub();
    const result = await callCloudCodeWithFailover({
      runtime,
      model: "gemini-3-flash",
      method: "generateContent",
      maxAttempts: 1,
      buildBody: (_account, candidateModel) => ({
        requestId: "agent-test",
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        model: candidateModel,
        userAgent: "test",
        requestType: "generate-content",
        project: "project-1"
      })
    });

    expect(result.ok).toBe(true);
    expect(callCloudCodeMock).toHaveBeenCalledTimes(2);
    expect(callCloudCodeMock.mock.calls[0][3].model).toBe("gemini-3-flash");
    expect(callCloudCodeMock.mock.calls[1][3].model).toBe("gemini-3.1-pro-high");
  });
});
