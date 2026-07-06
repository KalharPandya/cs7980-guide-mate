"use strict";
// Admin Health tab: polls /api/admin/health (Task 6) and renders the four
// panels. Reuses the `api`/`$` helpers admin.js already defines globally
// (this file is a plain <script>, loaded after admin.js, not a module) so it
// rides the same admin cookie + same-origin fetch base as every other tab.

function fmtAge(iso) {
  if (!iso) return "—";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 0) return "—";
  return secs < 90 ? secs + "s ago" : Math.round(secs / 60) + "m ago";
}

function gatesTextHealth(gates) {
  if (gates == null) return "—";
  if (typeof gates === "object")
    return Object.entries(gates).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return String(gates);
}

function renderHealth(data) {
  const robotsBody = document.querySelector("#health-robots-table tbody");
  robotsBody.innerHTML = (data.robots || []).map((r) => {
    const hb = r.last_heartbeat || {};
    const battery = r.battery != null ? Math.round(r.battery * 100) + "%" : "—";
    return `<tr><td>${r.robot_id}</td><td>${r.presence || "?"}</td>` +
      `<td>${fmtAge(hb.ts)}</td><td>${battery}</td>` +
      `<td>${gatesTextHealth(r.gates)}</td></tr>`;
  }).join("") || '<tr><td colspan="5" class="hint">No robots configured.</td></tr>';

  const cmdsBody = document.querySelector("#health-commands-table tbody");
  cmdsBody.innerHTML = (data.commands || []).map((c) =>
    `<tr><td>${(c.turn_id || "").slice(0, 8)}</td><td>${c.robot_id}</td>` +
    `<td>${(c.cmd_id || "").slice(0, 8)}</td><td>${(c.states || []).join("→")}</td>` +
    `<td>${c.total_ms}ms</td><td>${gatesTextHealth(c.gates)}</td>` +
    `<td>${c.simulated ? "sim" : "real"}</td></tr>`
  ).join("") || '<tr><td colspan="7" class="hint">No commands yet.</td></tr>';

  const latBody = document.querySelector("#health-latency-table tbody");
  latBody.innerHTML = (data.latencies || []).slice(0, 10).map((l) =>
    `<tr><td>${(l.turn_id || "").slice(0, 8)}</td><td>${l.bedrock_ms}ms</td>` +
    `<td>${l.session_id || "—"}</td></tr>`
  ).join("") || '<tr><td colspan="3" class="hint">No latency samples yet.</td></tr>';

  const errBody = document.querySelector("#health-errors-table tbody");
  errBody.innerHTML = (data.errors || []).slice(0, 10).map((e) =>
    `<tr><td>${e.where}</td><td>${e.message}</td><td>${fmtAge(e.ts)}</td></tr>`
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

window.startHealthPolling = function startHealthPolling() {
  loadHealth();
  if (!startHealthPolling._timer) {
    startHealthPolling._timer = setInterval(loadHealth, 3000);
  }
};
