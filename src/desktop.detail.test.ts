import { describe, expect, it, vi } from "vitest";
import { openTrafficDetailModal } from "../desktop/ui/trafficDetail.js";

describe("desktop traffic detail modal", () => {
  it("fills modal fields and wires copy actions", async () => {
    const nodes: Record<string, any> = {
      trafficDetailTitle: { textContent: "" },
      trafficDetailAt: { textContent: "" },
      trafficDetailDuration: { textContent: "" },
      trafficDetailTokens: { textContent: "" },
      trafficDetailProvider: { textContent: "", className: "" },
      trafficDetailModel: { textContent: "" },
      trafficDetailAccount: { textContent: "" },
      trafficDetailSystem: { textContent: "" },
      trafficDetailPrompt: { textContent: "" },
      trafficDetailTools: { textContent: "" },
      trafficDetailThinking: { textContent: "" },
      trafficDetailResponseSummary: { textContent: "" },
      trafficDetailRequest: { textContent: "" },
      trafficDetailResponse: { textContent: "" },
      trafficCopyRequest: { onclick: undefined },
      trafficCopyResponse: { onclick: undefined },
      trafficDetailModal: { showModal: vi.fn() }
    };
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
    const toast = { info: vi.fn() };

    openTrafficDetailModal({
      record: {
        at: "2026-04-27T10:00:00.000Z",
        statusCode: 200,
        method: "POST",
        route: "/v1/chat/completions",
        provider: "gemini",
        model: "gemini-2.5-pro",
        resolvedModel: "gemini-2.5-pro",
        account: "a@example.com",
        durationMs: 120,
        tokens: { input: 1, output: 2, total: 3 },
        requestBody: { messages: [{ role: "user", content: "hello" }] },
        responseBody: { choices: [{ message: { content: "hi" } }] }
      },
      getNode: (id: string) => nodes[id],
      formatTrafficPayload: (value: unknown) => JSON.stringify(value),
      toast
    });

    expect(nodes.trafficDetailTitle.textContent).toContain("/v1/chat/completions");
    expect(nodes.trafficDetailTokens.textContent).toBe("1 / 2 / 3");
    expect(nodes.trafficDetailProvider.className).toBe("protocol-text gemini");
    expect(nodes.trafficDetailPrompt.textContent).toBe("hello");
    expect(nodes.trafficDetailResponseSummary.textContent).toContain("hi");
    expect(nodes.trafficDetailModal.showModal).toHaveBeenCalled();

    await nodes.trafficCopyRequest.onclick();
    expect(toast.info).toHaveBeenCalledWith("Request kopyalandı");
  });
});
