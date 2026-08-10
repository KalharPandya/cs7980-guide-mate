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

    // Presence: online is online-dot + green "online" pill; anything else is a
    // muted dot + muted pill. Colour is ALWAYS paired with the presence label.
    const online = r.presence === "online";
    const title = document.createElement("div");
    title.className = "robot-title";
    const dot = document.createElement("span");
    dot.className = "dot " + (online ? "online" : "offline");
    title.appendChild(dot);
    const name = document.createElement("span");
    name.className = "robot-name";
    name.textContent = r.robot_id;
    title.appendChild(name);
    const presencePill = document.createElement("span");
    presencePill.className = "pill " + (online ? "pill-ok" : "pill-muted");
    presencePill.textContent = r.presence || "unknown";
    title.appendChild(presencePill);

    const battery = r.battery != null ? Math.round(r.battery * 100) + "%" : "?";
    const dock = r.docked == null ? "unknown" : r.docked ? "docked" : "undocked";
    const meta = document.createElement("div");
    meta.className = "robot-meta";
    // battery + dock as pills; gates stays as an explicit labelled span so the
    // safety-gate booleans (motion_enabled / dry_run) are always spelled out.
    const dockCls = r.docked === false ? "pill-warn" : "pill-neutral";
    meta.innerHTML =
      `<span class="pill pill-plain pill-neutral">battery ${battery}</span>` +
      `<span class="pill pill-plain ${dockCls}">${dock}</span>` +
      `<span class="pill pill-plain pill-muted">gates: ${gatesText(r.gates)}</span>`;

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
    tr.innerHTML = '<td colspan="4" class="hint">No documents yet. Upload a file above to seed the knowledge base, then Sync to ingest.</td>';
    tbody.appendChild(tr);
  }
}
// Styled file picker: mirror the chosen filename into the label (the native
// input is visually hidden, so its filename text is too).
$("kb-file").addEventListener("change", () => {
  const f = $("kb-file").files[0];
  $("kb-file-name").textContent = f ? f.name : "No file chosen";
});
$("kb-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = $("kb-file");
  if (!fileInput.files.length) return;
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  const resp = await api("/kb", { method: "POST", body: fd });
  if (!resp.ok) alert("Upload failed.");
  fileInput.value = "";
  $("kb-file-name").textContent = "No file chosen";
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

// Task 7 (virtual-pet grant): the approve control is multi-robot -- the admin
// picks which registered robot (physical turtlebot468 OR virtual turtlebotsim)
// a pending request gets bound to, instead of always hardcoding ROBOT_ID. The
// option list comes from the same /status registry the Robot + Maps tabs use.
async function _registryRobotIds() {
  const data = await (await api("/status")).json();
  const ids = (data.robots || []).map((r) => r.robot_id);
  return ids.length ? ids : [ROBOT_ID];
}

async function reloadRequests() {
  const [rs, robotIds] = await Promise.all([
    (await api("/requests")).json(),
    _registryRobotIds(),
  ]);
  const ul = $("requests-list");
  ul.innerHTML = "";
  rs.forEach((r) => {
    const li = document.createElement("li");
    li.dataset.testid = "request-row";

    const deny = document.createElement("button");
    deny.textContent = "Deny";
    deny.className = "secondary";
    deny.addEventListener("click", async () => {
      await api(`/requests/${r.request_id}/deny`, { method: "POST" });
      reloadRequests();
    });

    if (r.kind === "guide") {
      // VIRTUAL guide request: no physical-robot dropdown -- one button whose
      // approval fires the named assign (spawns the visitor + a guide robot).
      const from = r.from_room || "?";
      const to = r.to_room || "?";
      li.textContent = `${r.name} wants a guide: ${from} -> ${to}`;

      const approve = document.createElement("button");
      approve.textContent = "Approve (send guide)";
      approve.className = "btn-primary btn-sm";
      approve.dataset.testid = "approve-guide-btn";
      approve.addEventListener("click", async () => {
        await api(`/requests/${r.request_id}/approve-guide`, { method: "POST" });
        reloadRequests();
        reloadSessions();
      });
      li.append(" ", approve, " ", deny);
      ul.appendChild(li);
      return;
    }

    // companion / default: keep the existing physical-robot dropdown + Approve.
    li.textContent = `${r.name} (comfortable=${r.comfortable}) — ${r.session_id}`;

    const robotSelect = document.createElement("select");
    robotSelect.dataset.testid = "approve-robot-select";
    robotSelect.className = "approve-robot-select";
    robotIds.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id === "turtlebotsim" ? "Virtual pet - turtlebotsim" : id;
      robotSelect.appendChild(opt);
    });
    if (robotIds.includes(ROBOT_ID)) robotSelect.value = ROBOT_ID;

    const approve = document.createElement("button");
    approve.textContent = "Approve";
    approve.className = "btn-primary btn-sm";
    approve.dataset.testid = "approve-btn";
    approve.addEventListener("click", async () => {
      await api(`/requests/${r.request_id}/approve`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ robot_id: robotSelect.value }),
      });
      reloadRequests();
      reloadAssignEvents();
    });
    li.append(" ", robotSelect, " ", approve, " ", deny);
    ul.appendChild(li);
  });
  if (!rs.length) ul.innerHTML = "<li class=\"hint\">No pending requests. Approved companion requests will appear here for robot assignment.</li>";
}

// Brief inline confirmation for assign actions -- lives OUTSIDE the sessions
// list (which reloadSessions rebuilds), so the message survives the refresh.
function setSessionsStatus(text, ok) {
  const el = $("sessions-status");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "" : "var(--danger, #c0392b)";
}

async function reloadSessions() {
  // Pull the same registry robot-id list the Requests tab uses, so the
  // per-session physical picker offers every configured robot (not a hardcode).
  const [ss, robotIds] = await Promise.all([
    (await api("/sessions")).json(),
    _registryRobotIds(),
  ]);
  const ul = $("sessions-list");
  ul.innerHTML = "";
  ss.forEach((s) => {
    const li = document.createElement("li");
    // MODE: a bound robot_id means PHYSICAL (emotes); no binding means VIRTUAL
    // (navigation). This mirrors dog_agent's `physical = robot_for_session(...)`.
    const physical = Boolean(s.robot_id);
    const mode = physical ? `Physical: ${s.robot_id}` : "Virtual (navigation)";
    li.textContent = `${s.name} - ${s.request_status} - ${mode}`;

    const view = document.createElement("button");
    view.textContent = "Transcript";
    view.className = "secondary";
    view.addEventListener("click", async () => {
      const msgs = await (await api(`/sessions/${s.session_id}/messages`)).json();
      $("transcript").textContent =
        msgs.map((m) => `${m.role}: ${m.text}`).join("\n") || "(no messages)";
    });

    // (a) Assign PHYSICAL: pick a robot, then reassign (the existing endpoint).
    const robotSelect = document.createElement("select");
    robotSelect.className = "approve-robot-select";
    robotIds.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id === "turtlebotsim" ? "Virtual pet - turtlebotsim" : id;
      robotSelect.appendChild(opt);
    });
    if (physical && robotIds.includes(s.robot_id)) robotSelect.value = s.robot_id;
    const assignPhysical = document.createElement("button");
    assignPhysical.textContent = "Assign Physical";
    assignPhysical.addEventListener("click", async () => {
      const resp = await api(`/robot/${robotSelect.value}/reassign`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ session_id: s.session_id }),
      });
      setSessionsStatus(resp.ok
        ? `${s.name} assigned to ${robotSelect.value} (physical)`
        : `Assign to ${robotSelect.value} failed (${resp.status})`, resp.ok);
      reloadSessions();
      reloadAssignEvents();
    });

    // (b) Assign VIRTUAL: release any held physical robot + clear the binding.
    const assignVirtual = document.createElement("button");
    assignVirtual.textContent = "Assign Virtual (navigation)";
    assignVirtual.className = "secondary";
    assignVirtual.addEventListener("click", async () => {
      const resp = await api(`/session/${s.session_id}/assign-virtual`, { method: "POST" });
      setSessionsStatus(resp.ok
        ? `${s.name} set to Virtual (navigation)`
        : `Assign Virtual failed (${resp.status})`, resp.ok);
      reloadSessions();
      reloadAssignEvents();
    });

    li.append(" ", view, " ", robotSelect, " ", assignPhysical, " ", assignVirtual);
    ul.appendChild(li);
  });
  if (!ss.length) ul.innerHTML = "<li class=\"hint\">No active sessions. Visitor conversations will list here once they start.</li>";
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

// Scoped simulated-visitor pause/resume (see admin.py /world/sim-stop|resume).
// Halts only the ambient sim visitors that book guide robots; world keeps going.
async function sendSimCommand(path, label) {
  const el = $("sim-command-result");
  if (el) el.textContent = `${label}...`;
  try {
    const resp = await api(path, { method: "POST", headers: jsonHeaders });
    const out = await resp.json();
    if (el) el.textContent = resp.ok && out.ok
      ? `OK: ${label} (${(out.acks || []).length} ack(s))`
      : `FAILED: ${label} (${resp.status})`;
  } catch (err) {
    if (el) el.textContent = `FAILED: ${label} (${err})`;
  }
}
$("sim-stop").addEventListener("click",
  () => sendSimCommand("/world/sim-stop", "Stop simulated visitors"));
$("sim-resume").addEventListener("click",
  () => sendSimCommand("/world/sim-resume", "Resume simulated visitors"));

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
