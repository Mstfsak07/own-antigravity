import { normalizeTrafficRecord } from "./traffic.js";

function tokenText(tokens) {
  if (!tokens) return "-";
  return `${Number(tokens.input ?? 0)} / ${Number(tokens.output ?? 0)} / ${Number(tokens.total ?? 0)}`;
}

export function openTrafficDetailModal(options) {
  const {
    record,
    getNode,
    formatTrafficPayload,
    toast
  } = options;
  if (!record) return;

  const normalized = normalizeTrafficRecord(record, formatTrafficPayload);
  getNode("trafficDetailTitle").textContent = `${record.statusCode} ${record.method} ${record.route}`;
  getNode("trafficDetailAt").textContent = record.at ? new Date(record.at).toLocaleString() : "-";
  getNode("trafficDetailDuration").textContent = record.durationMs ? `${record.durationMs}ms` : "-";
  getNode("trafficDetailTokens").textContent = tokenText(record.tokens);
  getNode("trafficDetailProvider").textContent = record.provider || "-";
  getNode("trafficDetailModel").textContent = record.resolvedModel ? `${record.model} → ${record.resolvedModel}` : (record.model || "-");
  getNode("trafficDetailAccount").textContent = record.account || "-";
  getNode("trafficDetailSystem").textContent = normalized.system;
  getNode("trafficDetailPrompt").textContent = normalized.prompt;
  getNode("trafficDetailTools").textContent = normalized.tools;
  getNode("trafficDetailThinking").textContent = normalized.thinking;
  getNode("trafficDetailResponseSummary").textContent = normalized.responseSummary;
  getNode("trafficDetailRequest").textContent = formatTrafficPayload(record.requestBody);
  getNode("trafficDetailResponse").textContent = formatTrafficPayload(record.responseBody);
  getNode("trafficCopyRequest").onclick = async () => {
    await navigator.clipboard.writeText(formatTrafficPayload(record.requestBody));
    toast.info("Request kopyalandı");
  };
  getNode("trafficCopyResponse").onclick = async () => {
    await navigator.clipboard.writeText(formatTrafficPayload(record.responseBody));
    toast.info("Response kopyalandı");
  };
  getNode("trafficDetailModal").showModal();
}
