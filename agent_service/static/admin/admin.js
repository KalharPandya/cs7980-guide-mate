"use strict";
// Every request rides the HttpOnly admin cookie. same-origin is enough (and
// stricter than "include") because the UI is served from the same origin.
const api = (path, opts = {}) =>
  fetch("/api/admin" + path, { credentials: "same-origin", ...opts });
const jsonHeaders = { "Content-Type": "application/json" };

const $ = (id) => document.getElementById(id);
function show(el, on) { el.hidden = !on; }

// --- login ---------------------------------------------------------------
const loginView = $("login-view");
const panel = $("panel");
const loginError = $("login-error");

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const password = $("password").value;
  const resp = await api("/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ password }),
  });
  if (resp.ok) {
    enterPanel();
  } else if (resp.status === 429) {
    loginError.textContent = "Too many attempts — wait a minute.";
  } else if (resp.status === 503) {
    loginError.textContent = "Admin is not configured on the server.";
  } else {
    loginError.textContent = "Wrong password.";
  }
});

async function enterPanel() {
  show(loginView, false);
  show(panel, true);
  await loadFlags();
  await loadPrompt();
  // Poll the assignment undock/dock log so the Robot tab stays live. Guarded so
  // it only fetches once the operator is authenticated (avoids 401 spam).
  reloadAssignEvents();
  if (!enterPanel._assignTimer)
    enterPanel._assignTimer = setInterval(reloadAssignEvents, 3000);
}

// If a valid cookie already exists, skip the login screen.
(async () => {
  const resp = await api("/flags");
  if (resp.ok) enterPanel();
})();

// --- tabs ----------------------------------------------------------------
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = true));
    show($("tab-" + tab), true);
    if (tab === "requests") reloadRequests();
    if (tab === "sessions") reloadSessions();
    if (tab === "robot") { loadRobots(); reloadAssignEvents(); }
    if (tab === "knowledge") loadKb();
    if (tab === "maps") loadMapsTab();
    // Health polls on a 3s interval only while its tab is visible: start on
    // entering, stop on leaving (any other tab) so it doesn't poll forever.
    if (tab === "health") {
      if (window.startHealthPolling) window.startHealthPolling();
    } else if (window.stopHealthPolling) {
      window.stopHealthPolling();
    }
  });
});

// --- flags ---------------------------------------------------------------
async function loadFlags() {
  const flags = await (await api("/flags")).json();
  const list = $("flags-list");
  list.innerHTML = "";
  Object.keys(flags).sort().forEach((name) => {
    const label = document.createElement("label");
    label.className = "flag";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = flags[name];
    cb.addEventListener("change", async () => {
      const resp = await api("/flags", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ name, value: cb.checked }),
      });
      if (!resp.ok) {
        cb.checked = !cb.checked; // revert on failure
        alert("Could not save flag " + name);
      }
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + name));
    list.appendChild(label);
  });
}

// --- prompt --------------------------------------------------------------
async function loadPrompt() {
  const data = await (await api("/prompt")).json();
  $("prompt-text").value = data.system_prompt || "";
}
$("prompt-save").addEventListener("click", async () => {
  const val = $("prompt-text").value;
  const resp = await api("/prompt", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ system_prompt: val === "" ? null : val }),
  });
  $("prompt-status").textContent = resp.ok ? "Saved." : "Save failed.";
});
$("prompt-clear").addEventListener("click", async () => {
  const resp = await api("/prompt", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ system_prompt: null }),
  });
  if (resp.ok) $("prompt-text").value = "";
  $("prompt-status").textContent = resp.ok ? "Reset to persona." : "Reset failed.";
});

// --- robot ---------------------------------------------------------------
function gatesText(gates) {
  if (gates == null) return "unknown";
  if (typeof gates === "object")
    return Object.entries(gates).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return String(gates);
}

async function loadRobots() {
  const data = await (await api("/status")).json();
  const list = $("robot-list");
  list.innerHTML = "";
  (data.robots || []).forEach((r) => {
    const card = document.createElement("div");
    card.className = "robot";

    const title = document.createElement("div");
    title.className = "robot-title";
    const dot = document.createElement("span");
    dot.className = "dot " + (r.presence === "online" ? "online" : "offline");
    title.appendChild(dot);
    title.appendChild(document.createTextNode(r.robot_id + " — " + (r.presence || "unknown")));

    const battery = r.battery != null ? Math.round(r.battery * 100) + "%" : "?";
    const dock = r.docked == null ? "unknown" : r.docked ? "docked" : "undocked";
    const meta = document.createElement("div");
    meta.className = "robot-meta";
    meta.innerHTML =
      `<span>battery ${battery}</span>` +
      `<span>${dock}</span>` +
      `<span>gates: ${gatesText(r.gates)}</span>`;

    const kill = document.createElement("button");
    kill.textContent = "KILL SWITCH";
    kill.className = "danger";
    kill.addEventListener("click", async () => {
      if (!confirm(`Kill switch ${r.robot_id}? (sets dry_run + motion off)`)) return;
      const resp = await api("/kill-switch", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ robot_id: r.robot_id }),
      });
      alert(resp.ok ? "Kill switch sent." : "Kill switch failed.");
    });

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(kill);
    list.appendChild(card);
  });
  if (!(data.robots || []).length) list.textContent = "No robots configured.";
}
$("robot-refresh").addEventListener("click", loadRobots);

// --- knowledge -----------------------------------------------------------
async function loadKb() {
  const data = await (await api("/kb")).json();
  const tbody = document.querySelector("#kb-table tbody");
  tbody.innerHTML = "";
  (data.docs || []).forEach((d) => {
    const tr = document.createElement("tr");
    const kb = (d.size / 1024).toFixed(1) + " KB";
    tr.innerHTML = `<td>${d.key}</td><td>${kb}</td><td>${d.modified}</td>`;
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.addEventListener("click", async () => {
      if (!confirm("Delete " + d.key + "?")) return;
      await api("/kb?key=" + encodeURIComponent(d.key), { method: "DELETE" });
      loadKb();
    });
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  });
  if (!(data.docs || []).length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4" class="hint">No documents.</td>';
    tbody.appendChild(tr);
  }
}
$("kb-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = $("kb-file");
  if (!fileInput.files.length) return;
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  const resp = await api("/kb", { method: "POST", body: fd });
  if (!resp.ok) alert("Upload failed.");
  fileInput.value = "";
  loadKb();
});
$("kb-sync").addEventListener("click", async () => {
  const status = $("kb-sync-status");
  status.textContent = "Starting ingestion…";
  const start = await (await api("/kb/sync", { method: "POST" })).json();
  if (start.ok === false) {
    status.textContent = "Sync failed: " + (start.error || "unknown");
    return;
  }
  // Poll the ingestion job a few times so the operator sees it progress.
  let tries = 0;
  const poll = async () => {
    const s = await (await api("/kb/sync-status")).json();
    status.textContent = "Ingestion: " + (s.status || "?");
    const done = ["COMPLETE", "FAILED", "NONE", "ERROR"].includes(s.status);
    if (!done && tries++ < 20) setTimeout(poll, 3000);
  };
  poll();
});

// --- requests / sessions / robot-session controls (Task 6) ---------------
// The bind on approve/reassign fires a best-effort assignment undock/dock; on
// robot 468 (motion-locked) the ack is a refusal — that refusal is the Phase 4
// evidence and is shown deliberately in the assignment-events panel below.
const ROBOT_ID = "turtlebot468";

async function reloadRequests() {
  const rs = await (await api("/requests")).json();
  const ul = $("requests-list");
  ul.innerHTML = "";
  rs.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = `${r.name} (comfortable=${r.comfortable}) — ${r.session_id}`;
    const approve = document.createElement("button");
    approve.textContent = "Approve";
    approve.addEventListener("click", async () => {
      await api(`/requests/${r.request_id}/approve`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ robot_id: ROBOT_ID }),
      });
      reloadRequests();
      reloadAssignEvents();
    });
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    deny.className = "secondary";
    deny.addEventListener("click", async () => {
      await api(`/requests/${r.request_id}/deny`, { method: "POST" });
      reloadRequests();
    });
    li.append(" ", approve, " ", deny);
    ul.appendChild(li);
  });
  if (!rs.length) ul.innerHTML = "<li class=\"hint\">No pending requests.</li>";
}

async function reloadSessions() {
  const ss = await (await api("/sessions")).json();
  const ul = $("sessions-list");
  ul.innerHTML = "";
  ss.forEach((s) => {
    const li = document.createElement("li");
    li.textContent = `${s.name} — ${s.request_status} — robot=${s.robot_id || "-"}`;
    const view = document.createElement("button");
    view.textContent = "Transcript";
    view.className = "secondary";
    view.addEventListener("click", async () => {
      const msgs = await (await api(`/sessions/${s.session_id}/messages`)).json();
      $("transcript").textContent =
        msgs.map((m) => `${m.role}: ${m.text}`).join("\n") || "(no messages)";
    });
    const reassign = document.createElement("button");
    reassign.textContent = "Give robot";
    reassign.addEventListener("click", async () => {
      await api(`/robot/${ROBOT_ID}/reassign`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ session_id: s.session_id }),
      });
      reloadSessions();
      reloadAssignEvents();
    });
    li.append(" ", view, " ", reassign);
    ul.appendChild(li);
  });
  if (!ss.length) ul.innerHTML = "<li class=\"hint\">No sessions.</li>";
}

$("reload-requests").addEventListener("click", reloadRequests);
$("reload-sessions").addEventListener("click", reloadSessions);

$("robot-abort").addEventListener("click", async () => {
  if (!confirm(`Abort ${ROBOT_ID}'s session? (releases the lock + docks)`)) return;
  const out = await (await api(`/robot/${ROBOT_ID}/abort`, { method: "POST" })).json();
  $("robot-command-result").textContent =
    "Freed session: " + (out.freed_session_id || "(none)");
  reloadAssignEvents();
});

async function sendRobotCommand(type, name) {
  const out = await (await api(`/robot/${ROBOT_ID}/command`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ type, name }),
  })).json();
  const last = out.acks[out.acks.length - 1];
  // Show the refusal ack verbatim — refusals ARE the expected Phase 4 outcome.
  $("robot-command-result").textContent =
    (out.refused ? "REFUSED: " : "OK: ") + (last ? last.reason || last.state : "");
}
$("robot-dock").addEventListener("click", () => sendRobotCommand("motion", "dock"));
$("robot-stop").addEventListener("click", () => sendRobotCommand("stop", "stop"));

// --- maps ------------------------------------------------------------------
// Robot picker is populated from the same /status list the Robot tab uses
// (data.robots), not hardcoded to ROBOT_ID -- the Maps tab supports every
// configured robot, not just the one wired into the session/assignment demo.
async function populateMapsRobotSelect() {
  const sel = $("maps-robot");
  const previous = sel.value;
  const data = await (await api("/status")).json();
  const robotIds = (data.robots || []).map((r) => r.robot_id);
  if (!robotIds.length) robotIds.push(ROBOT_ID); // fall back to the known default
  sel.innerHTML = "";
  robotIds.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  });
  if (robotIds.includes(previous)) sel.value = previous;
}

async function loadMap(robotId) {
  const img = $("maps-image");
  const empty = $("maps-empty");
  const ts = $("maps-timestamp");
  try {
    const metaResp = await api(`/map/${robotId}/meta.json`);
    if (!metaResp.ok) throw new Error("no map");
    const meta = await metaResp.json();
    ts.textContent = `Captured: ${meta.captured_ts} (source: ${meta.source})`;
    // Cache-bust so a re-uploaded map replaces the browser's cached image;
    // the admin cookie rides along same-origin.
    img.src = `/api/admin/map/${robotId}?t=${Date.now()}`;
    img.hidden = false;
    empty.hidden = true;
  } catch (e) {
    img.hidden = true;
    empty.hidden = false;
    ts.textContent = "—";
  }
}

async function loadMapsTab() {
  await populateMapsRobotSelect();
  loadMap($("maps-robot").value);
}

$("maps-robot").addEventListener("change", (e) => loadMap(e.target.value));

async function reloadAssignEvents() {
  // Never throws: the login screen / a transient 401 just leaves the last text.
  try {
    const resp = await api(`/robot/${ROBOT_ID}/assign-events`);
    if (!resp.ok) return;
    const evs = await resp.json();
    $("assign-event").textContent = evs.length
      ? evs.map((e) => {
          const last = e.acks[e.acks.length - 1];
          const outcome = e.refused
            ? "REFUSED — " + (last.reason || last.state)
            : (last ? last.state : "no ack (robot unreachable)");
          return `${e.ts}  ${e.action}: ${outcome}`;
        }).join("\n")
      : "No assignment commands yet.";
  } catch (err) { /* keep polling */ }
}
