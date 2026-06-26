import { describe, expect, it, vi } from "vitest";
import {
  existingGatewayNeedsRestart,
  hasOnlyUnhealthyCloudCode,
  requestExistingGatewayShutdown
} from "./desktopGateway.js";

describe("desktop gateway self-heal", () => {
  it("detects stale cloudCode health snapshots", () => {
    expect(hasOnlyUnhealthyCloudCode({ cloudCode: { accountCount: 3, healthyCount: 0 } })).toBe(true);
    expect(hasOnlyUnhealthyCloudCode({ cloudCode: { accountCount: 3, healthyCount: 1 } })).toBe(false);
    expect(hasOnlyUnhealthyCloudCode({ cloudCode: { accountCount: 0, healthyCount: 0 } })).toBe(false);
    expect(hasOnlyUnhealthyCloudCode({})).toBe(false);
  });

  it("requests provider health with local bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cloudCode: { accountCount: 5, healthyCount: 0 } })
    });

    const result = await existingGatewayNeedsRestart("http://127.0.0.1:8046", "sk-antigravity", fetchMock as typeof fetch);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8046/health/providers",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-antigravity" }
      })
    );
  });

  it("does not restart healthy or unreadable existing gateways", async () => {
    const healthyFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cloudCode: { accountCount: 5, healthyCount: 2 } })
    });
    const nonOkFetch = vi.fn().mockResolvedValue({ ok: false });
    const failingFetch = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(existingGatewayNeedsRestart("http://127.0.0.1:8046", "sk", healthyFetch as typeof fetch)).resolves.toBe(false);
    await expect(existingGatewayNeedsRestart("http://127.0.0.1:8046", "sk", nonOkFetch as typeof fetch)).resolves.toBe(false);
    await expect(existingGatewayNeedsRestart("http://127.0.0.1:8046", "sk", failingFetch as typeof fetch)).resolves.toBe(false);
    await expect(existingGatewayNeedsRestart("http://127.0.0.1:8046", undefined, healthyFetch as typeof fetch)).resolves.toBe(false);
  });

  it("shuts down and waits until the stale gateway disappears", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const reachable = vi
      .fn<(url: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await requestExistingGatewayShutdown(
      "http://127.0.0.1:8046",
      "sk-antigravity",
      reachable,
      fetchMock as typeof fetch
    );

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8046/admin/shutdown",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-antigravity",
          "content-type": "application/json"
        }),
        body: "{}"
      })
    );
    expect(reachable).toHaveBeenCalledTimes(2);
  });
});
