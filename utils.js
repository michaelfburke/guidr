export function sw(msg) {
  return new Promise(res => chrome.runtime.sendMessage(msg, (r) => res(r || null)));
}
export function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}
export function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}
export function formatMs(ms) {
  const total = Math.max(0, ms || 0) / 1000;
  const m = Math.floor(total / 60);
  const s = (total - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}
export function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
export function formatApiError(raw) {
  if (!raw) return "Something went wrong. Check the service worker console.";
  const s = String(raw);
  if (/\b429\b|quota|rate.?limit|resource_exhausted/i.test(s)) {
    const retryMatch = s.match(/retry after (\d+(?:\.\d+)?)s/i);
    const waitHint = retryMatch
      ? ` Try again in ~${Math.ceil(Number(retryMatch[1]))}s.`
      : " Wait a moment and retry, or switch model in Settings.";
    const apiMsg = s
      .replace(/^\w+\s+\d{3}:\s*/, "")
      .replace(/\s*\(retry after [^)]+\)\s*$/i, "")
      .trim();
    const detail = apiMsg.length > 140 ? apiMsg.slice(0, 137) + "…" : apiMsg;
    return `Rate limit: ${detail}.${waitHint}`;
  }
  if (/insufficient|billing|payment.?required|\b402\b/i.test(s))
    return "Account has no credits. Top up at your provider's billing page, then retry.";
  if (/\b401\b|unauthorized|invalid.?api.?key|api.?key.?not.?valid/i.test(s))
    return "API key was rejected. Re-check it in Settings under Provider.";
  if (/\b404\b|model.*not.?(found|exist)|no.?such.?model/i.test(s))
    return "Selected model isn't available for your key. Pick a different one in Settings.";
  if (/\b403\b|permission|forbidden|safety|blocked/i.test(s))
    return "Provider refused the request (permission or safety filter). Try a different model.";
  return s.length > 180 ? s.slice(0, 177) + "…" : s;
}
