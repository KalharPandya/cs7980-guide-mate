"use strict";
// Admin Health tab: polls /api/admin/health (Task 6) and renders the four
// panels. Reuses the `api()`/`$()` globals admin.js already defines (this file
// is a plain <script>, loaded after admin.js, not a module) so it rides the
// same admin cookie + same-origin fetch base as every other tab.

// SECURITY — XSS defense. Every dynamic field below is UNTRUSTED: errors[].message
// is str(exc) and can echo the UNAUTHENTICATED /ws/chat user's raw input; robot
// `gates`/`last_heartbeat` come from an MQTT heartbeat a spoofed publisher could
// forge; cmd/turn/session ids and states flow from the same paths. This page can
// fire the kill switch and rewrite the system prompt, so injected markup running
// in the admin's browser is a privilege-relevant risk. RULE: NO raw `${value}`
// may ever appear inside an innerHTML string — every interpolated dynamic field
// MUST be wrapped in esc(). If you add a column, wrap it.
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtAge(iso) {
  if (!iso) return "—";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 0 || !isFinite(secs)) return "—";
  return secs < 90 ? secs + "s ago" : Math.round(secs / 60) + "m ago";
}

function gatesTextHealth(gates) {
  if (gates == null) return "—";
  if (typeof gates === "object")
    return Object.entries(gates).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return String(gates);
}

function renderHealth(data) {
  // fmtAge returns only safe literals ("Ns ago"/"—"); the `sim`/`real` literal is
  // fixed; EVERY other interpolated field is esc()'d (untrusted — see header note).
  const robotsBody = document.querySelector("#health-robots-table tbody");
  robotsBody.innerHTML = (data.robots || []).map((r) => {
    const hb = r.last_heartbeat || {};
    const battery = r.battery != null ? Math.round(r.battery * 100) + "%" : "—";
    return `<tr><td>${esc(r.robot_id)}</td><td>${esc(r.presence || "?")}</td>` +
      `<td>${fmtAge(hb.ts)}</td><td>${esc(battery)}</td>` +
      `<td>${esc(gatesTextHealth(r.gates))}</td></tr>`;
  }).join("") || '<tr><td colspan="5" class="hint">No robots configured.</td></tr>';

  const cmdsBody = document.querySelector("#health-commands-table tbody");
  cmdsBody.innerHTML = (data.commands || []).map((c) =>
    `<tr><td>${esc((c.turn_id || "").slice(0, 8))}</td><td>${esc(c.robot_id)}</td>` +
    `<td>${esc((c.cmd_id || "").slice(0, 8))}</td><td>${esc((c.states || []).join("→"))}</td>` +
    `<td>${esc(c.total_ms)}ms</td><td>${esc(gatesTextHealth(c.gates))}</td>` +
    `<td>${c.simulated ? "sim" : "real"}</td></tr>`
  ).join("") || '<tr><td colspan="7" class="hint">No commands yet.</td></tr>';

  const latBody = document.querySelector("#health-latency-table tbody");
  latBody.innerHTML = (data.latencies || []).slice(0, 10).map((l) =>
    `<tr><td>${esc((l.turn_id || "").slice(0, 8))}</td><td>${esc(l.bedrock_ms)}ms</td>` +
    `<td>${esc(l.session_id || "—")}</td></tr>`
  ).join("") || '<tr><td colspan="3" class="hint">No latency samples yet.</td></tr>';

  const errBody = document.querySelector("#health-errors-table tbody");
  errBody.innerHTML = (data.errors || []).slice(0, 10).map((e) =>
    `<tr><td>${esc(e.where)}</td><td>${esc(e.message)}</td><td>${fmtAge(e.ts)}</td></tr>`
  ).join("") || '<tr><td colspan="3" class="hint">No errors.</td></tr>';
}

async function loadHealth() {
  try {
    const resp = await api("/health");
    if (!resp.ok) return;
    renderHealth(await resp.json());
  } catch (e) {
    // keep the last-rendered panel; a transient fetch failure shouldn't blank it
  }
}

// Poll ONLY while the Health tab is visible. admin.js's tab-switch handler calls
// startHealthPolling() on entering "health" and stopHealthPolling() on leaving
// any tab, so the 3s interval doesn't run for the life of the page after one visit.
window.startHealthPolling = function startHealthPolling() {
  loadHealth();
  if (!window.startHealthPolling._timer) {
    window.startHealthPolling._timer = setInterval(loadHealth, 3000);
  }
};

window.stopHealthPolling = function stopHealthPolling() {
  if (window.startHealthPolling._timer) {
    clearInterval(window.startHealthPolling._timer);
    window.startHealthPolling._timer = null;
  }
};
