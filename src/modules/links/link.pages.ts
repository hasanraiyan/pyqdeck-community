/**
 * Static pages for the link host (NFR-SEC-10): no scripts, no third-party resources, every dynamic value escaped.
 * English first, Hindi second (TBD-27).
 */
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#14181f;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{max-width:440px;width:100%;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{margin:8px 0}.host{font-weight:700;word-break:break-all}
.hi{color:#566070;font-size:14px}.row{display:flex;gap:12px;margin-top:20px}
a.btn{flex:1;text-align:center;padding:12px;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid #c7ccd4;color:#14181f}
a.go{background:#14181f;color:#fff;border-color:#14181f}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#eef0f3}main{background:#1a1d24}a.btn{color:#eef0f3;border-color:#3a3f4a}a.go{background:#eef0f3;color:#14181f}.hi{color:#9aa3b2}}
</style>
</head>
<body><main>${body}</main></body>
</html>`;

const REASONS: Record<string, [string, string]> = {
  suspicious: ["This link looks suspicious.", "यह लिंक संदिग्ध लग रहा है।"],
  unchecked: ["We could not check this link.", "हम इस लिंक की जाँच नहीं कर सके।"],
  lookalike: [
    "This address uses special characters and may imitate another site.",
    "इस पते में विशेष अक्षर हैं और यह किसी और साइट की नकल हो सकता है।",
  ],
  recheck_failed: ["We could not re-check this link just now.", "हम अभी इस लिंक की दोबारा जाँच नहीं कर सके।"],
};

export function warningPage(input: { host: string; code: string; reason: string }) {
  const [en, hi] = REASONS[input.reason] ?? REASONS.unchecked;
  return layout(
    "Leaving PYQDeck",
    `<h1>You are leaving PYQDeck</h1>
<p>${escapeHtml(en)}</p>
<p>It goes to <span class="host">${escapeHtml(input.host)}</span></p>
<p class="hi">${escapeHtml(hi)} PYQDeck इस साइट के लिए ज़िम्मेदार नहीं है।</p>
<div class="row"><a class="btn" href="https://pyqdeck.in/">Back to PYQDeck</a><a class="btn go" href="/${encodeURIComponent(input.code)}/go" rel="nofollow noopener noreferrer">Continue</a></div>`,
  );
}

export function blockedPage() {
  return layout(
    "Link blocked",
    `<h1>This link was blocked</h1><p>It may be unsafe, so PYQDeck will not open it.</p><p class="hi">यह लिंक असुरक्षित हो सकता है, इसलिए PYQDeck इसे नहीं खोलेगा।</p>`,
  );
}

export function gonePage() {
  return layout(
    "Link no longer available",
    `<h1>This link is no longer available</h1><p>The post that contained it was removed.</p><p class="hi">जिस पोस्ट में यह लिंक था, उसे हटा दिया गया है।</p>`,
  );
}

export function notFoundPage() {
  return layout("Not found", `<h1>Link not found</h1><p>Check the address and try again.</p>`);
}
