import { beforeEach, describe, expect, it, vi } from "vitest";
import { callCloudCodeWithFailover } from "./cloudCodeFailover.js";
import type { Runtime } from "../runtime.js";

const callCloudCodeMock = vi.hoisted(() => vi.fn());
const ensureCloudCodeProjectIdMock = vi.hoisted(() => vi.fn());

vi.mock("../cloudCode/client.js", () => ({
  callCloudCode: callCloudCodeMock
}));

vi.mock("../cloudCode/quota.js", () => ({
  ensureCloudCodeProjectId: ensureCloudCodeProjectIdMock
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
      clearProjectId: vi.fn().mockImplementation((accountId: string) => {
        if (accountId === account.id) {
          account.projectId = undefined;
          return account;
        }
        return undefined;
      }),
      refresh: vi.fn().mockResolvedValue(account)
    } as any
  } as Runtime;
}

function accountStub(id: string, model = "claude-sonnet-4-6") {
  return {
    id,
    email: `${id}@example.test`,
    accessToken: `token-${id}`,
    refreshToken: `refresh-${id}`,
    projectId: `project-${id}`,
    quotaModels: [{ name: model, percentage: 100 }],
    disabled: false,
    health: { healthy: true, consecutiveFailures: 0 }
  } as any;
}

describe("callCloudCodeWithFailover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureCloudCodeProjectIdMock.mockImplementation(async (_config, account) => account);
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
    expect(callCloudCodeMock.mock.calls[1][1].projectId).toBeUndefined();
    expect(runtime.cloudCodeAccounts.clearProjectId).toHaveBeenCalledWith("acc-1");
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
    expect(runtime.cloudCodeAccounts.reportStatusFailure).not.toHaveBeenCalled();
    expect(runtime.cloudCodeAccounts.noteModelFailure).toHaveBeenCalledWith("acc-1", "gemini-3-flash", 500);
  });

  it("still quarantines the whole account on rate limits", async () => {
    callCloudCodeMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 429, message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" }
      })
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

    expect(result.ok).toBe(false);
    expect(runtime.cloudCodeAccounts.reportStatusFailure).toHaveBeenCalledWith("acc-1", 429);
    expect(runtime.cloudCodeAccounts.noteModelFailure).toHaveBeenCalledWith("acc-1", "gemini-3-flash", 429);
  });

  it("caps timeout failover attempts within a single model", async () => {
    callCloudCodeMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));

    const runtime = runtimeStub();
    const accounts = [accountStub("slow-1", "custom-model"), accountStub("slow-2", "custom-model"), accountStub("slow-3", "custom-model")];
    runtime.cloudCodeAccounts.select = vi.fn(async (_model: string, options?: { excludeIds?: string[] }) =>
      accounts.find((account) => !options?.excludeIds?.includes(account.id))
    );

    const result = await callCloudCodeWithFailover({
      runtime,
      model: "custom-model",
      method: "generateContent",
      maxAttempts: 5,
      buildBody: (_account, candidateModel) => ({
        requestId: "agent-test",
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        model: candidateModel,
        userAgent: "test",
        requestType: "generate-content"
      })
    });

    expect(result.ok).toBe(false);
    expect(callCloudCodeMock).toHaveBeenCalledTimes(2);
    expect(runtime.cloudCodeAccounts.reportFailure).toHaveBeenCalledWith("slow-1", "timeout");
    expect(runtime.cloudCodeAccounts.reportFailure).toHaveBeenCalledWith("slow-2", "timeout");
    expect(runtime.cloudCodeAccounts.noteModelFailure).toHaveBeenCalledWith("slow-1", "custom-model", "timeout");
  });

  it("falls back from Claude Sonnet to Haiku after repeated timeouts", async () => {
    callCloudCodeMock
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
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
    const sonnetAccounts = [accountStub("sonnet-1"), accountStub("sonnet-2")];
    const haikuAccount = accountStub("haiku-1", "claude-haiku-4-5");
    runtime.cloudCodeAccounts.select = vi.fn(async (candidateModel: string, options?: { excludeIds?: string[] }) => {
      const candidates = candidateModel === "claude-haiku-4-5" ? [haikuAccount] : sonnetAccounts;
      return candidates.find((account) => !options?.excludeIds?.includes(account.id));
    });

    const result = await callCloudCodeWithFailover({
      runtime,
      model: "claude-sonnet-4-6",
      method: "generateContent",
      maxAttempts: 5,
      buildBody: (_account, candidateModel) => ({
        requestId: "agent-test",
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        model: candidateModel,
        userAgent: "test",
        requestType: "generate-content"
      })
    });

    expect(result.ok).toBe(true);
    expect(callCloudCodeMock).toHaveBeenCalledTimes(3);
    expect(callCloudCodeMock.mock.calls.map((call) => call[3].model)).toEqual([
      "claude-sonnet-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5"
    ]);
    expect(result.ok && result.account.id).toBe("haiku-1");
  });

  it("treats upstream 504 responses as timeout cooldowns", async () => {
    callCloudCodeMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 504, message: "The operation was aborted due to timeout" } }), {
        status: 504,
        headers: { "content-type": "application/json" }
      })
    );

    const runtime = runtimeStub();
    const result = await callCloudCodeWithFailover({
      runtime,
      model: "custom-model",
      method: "generateContent",
      maxAttempts: 5,
      buildBody: (_account, candidateModel) => ({
        requestId: "agent-test",
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        model: candidateModel,
        userAgent: "test",
        requestType: "generate-content"
      })
    });

    expect(result.ok).toBe(false);
    expect(callCloudCodeMock).toHaveBeenCalledTimes(2);
    expect(runtime.cloudCodeAccounts.reportFailure).toHaveBeenCalledWith("acc-1", "timeout");
    expect(runtime.cloudCodeAccounts.reportStatusFailure).not.toHaveBeenCalled();
    expect(runtime.cloudCodeAccounts.noteModelFailure).toHaveBeenCalledWith("acc-1", "custom-model", "timeout");
  });

  it("hydrates a missing project id before flash-image CloudCode calls", async () => {
    callCloudCodeMock.mockResolvedValue(
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
    ensureCloudCodeProjectIdMock.mockImplementation(async (_config, account) => ({
      ...account,
      projectId: "bootstrapped-project"
    }));

    const runtime = runtimeStub();
    const projectlessAccount = {
      ...(await runtime.cloudCodeAccounts.select("gemini-3.1-flash-image")),
      projectId: undefined
    } as any;
    runtime.cloudCodeAccounts.select = vi.fn().mockResolvedValue(projectlessAccount);
    runtime.cloudCodeAccounts.addOrUpdate = vi.fn();

    const result = await callCloudCodeWithFailover({
      runtime,
      model: "gemini-3.1-flash-image",
      method: "generateContent",
      buildBody: (account, candidateModel) => ({
        requestId: "agent-test",
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        model: candidateModel,
        userAgent: "test",
        requestType: "generate-content",
        ...(account.projectId ? { project: account.projectId } : {})
      })
    });

    expect(result.ok).toBe(true);
    expect(ensureCloudCodeProjectIdMock).toHaveBeenCalled();
    expect(runtime.cloudCodeAccounts.addOrUpdate).toHaveBeenCalledWith(expect.objectContaining({ projectId: "bootstrapped-project" }));
    expect(callCloudCodeMock.mock.calls[0][3].project).toBe("bootstrapped-project");
  });
});
