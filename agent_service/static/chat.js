(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const intake = $("intake");
  const chatSection = $("chat");
  const nameInput = $("name");
  const comfortableInput = $("comfortable");
  const startBtn = $("start");
  const newSessionBtn = $("new-session");

  const messages = $("messages");
  const form = $("chat-form");
  const input = $("message");
  const avatar = $("avatar");
  const emoteLabel = $("emote-label");
  const player = $("player");
  const micBtn = $("mic");
  const micBar = $("mic-level-bar");
  const chip = $("status-chip");
  const chipMode = $("status-mode");
  const banner = $("companion-banner");
  const bannerText = $("companion-status");
  const requestBtn = $("request-companion");
  const virtualPetBadge = $("virtual-pet-badge");
  const toast = $("toast");

  // --- session id: minted by POST /api/session at intake, mirrored in
  // localStorage. A real session row is required for /api/session/{id}/state
  // and /request-companion to resolve (both 404 on an unknown id), so unlike
  // a purely client-generated UUID, the intake step is kept -- see
  // p5-task-5-report.md "brief-vs-reality adaptations". ---
  let sessionId = localStorage.getItem("guidemate_session_id");

  function showChat() {
    intake.hidden = true;
    intake.classList.add("hidden");
    chatSection.hidden = false;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add("hidden"), 3500);
  }

  function addBubble(role, text, emote) {
    const div = document.createElement("div");
    div.className = "bubble " + (role === "you" ? "you" : "dog");
    div.textContent = text;
    if (emote) {
      const tag = document.createElement("span");
      tag.className = "emote-tag";
      tag.textContent = "emote: " + emote;
      div.appendChild(tag);
    }
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // --- emote <-> audio sync -------------------------------------------------
  // The explicit requirement: the avatar animation must play IN SYNC with the
  // spoken reply, not before/after it. The "reply" frame (text + emote) and
  // the "audio" frame (mp3) arrive back-to-back over the same WS turn; we hold
  // the emote until the <audio> element actually starts playing (its `play`
  // event), so the wiggle/nod/shake and the voice start on the same frame.
  let pendingEmote = null;
  let pendingTimer = null;

  function triggerEmote(emote) {
    if (!emote) return;
    avatar.classList.remove("emote-happy", "emote-yes", "emote-no");
    void avatar.offsetWidth; // restart animation
    avatar.classList.add("emote-" + emote);
    emoteLabel.textContent = emote;
    setTimeout(() => avatar.classList.remove("emote-" + emote), 1400);
  }

  function armPendingEmote(emote) {
    pendingEmote = emote || null;
    clearTimeout(pendingTimer);
    if (pendingEmote) {
      // Fallback: if TTS fails and no "audio" frame ever arrives, don't leave
      // the dog frozen forever -- play the emote anyway after a short grace
      // window (longer than a normal turn's TTS round-trip).
      pendingTimer = setTimeout(() => {
        if (pendingEmote) {
          triggerEmote(pendingEmote);
          pendingEmote = null;
        }
      }, 3000);
    }
  }

  player.addEventListener("play", () => {
    if (pendingEmote) {
      clearTimeout(pendingTimer);
      triggerEmote(pendingEmote);
      pendingEmote = null;
    }
  });

  // --- WebSocket -------------------------------------------------------------
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  let ws = null;
  let wsClosedByUs = false;

  function setConnDetail(connected) {
    chip.title = connected ? "connected" : "reconnecting…";
  }

  function connect() {
    if (!sessionId) return;
    ws = new WebSocket(`${wsProto}://${location.host}/ws/chat/${sessionId}`);
    ws.onopen = () => setConnDetail(true);
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === "transcript") {
        if (msg.text) addBubble("you", msg.text);
      } else if (msg.type === "reply") {
        addBubble("dog", msg.text, msg.emote);
        armPendingEmote(msg.emote);
      } else if (msg.type === "audio") {
        try {
          const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: "audio/mpeg" });
          player.src = URL.createObjectURL(blob);
          player.play().catch(() => {
            // Autoplay blocked (no user gesture in this tick) -- still
            // release the emote so the avatar isn't stuck waiting forever.
            if (pendingEmote) {
              triggerEmote(pendingEmote);
              pendingEmote = null;
            }
          });
        } catch (e) {
          if (pendingEmote) {
            triggerEmote(pendingEmote);
            pendingEmote = null;
          }
        }
      } else if (msg.type === "error") {
        showToast(msg.message || "Something went wrong, try again.");
      }
    };
    ws.onclose = () => {
      setConnDetail(false);
      if (!wsClosedByUs) setTimeout(connect, 1500);
    };
    ws.onerror = () => {
      /* onclose follows; reconnect handled there */
    };
  }

  window.addEventListener("beforeunload", () => {
    wsClosedByUs = true;
  });

  function wsSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      return true;
    }
    showToast("Not connected yet — reconnecting…");
    return false;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addBubble("you", text);
    input.value = "";
    wsSend(JSON.stringify({ type: "text", message: text }));
  });

  // --- push-to-talk mic: capture -> 16k Int16 PCM -> WS binary --------------
  const TARGET_RATE = 16000;
  let audioCtx = null, micStream = null, workletNode = null, recording = false;

  function floatTo16kPCM(float32, inRate) {
    let data = float32;
    if (inRate !== TARGET_RATE) {
      const ratio = inRate / TARGET_RATE;
      const outLen = Math.round(float32.length / ratio);
      data = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const left = Math.floor(pos);
        const right = Math.min(left + 1, float32.length - 1);
        const frac = pos - left;
        data[i] = float32[left] * (1 - frac) + float32[right] * frac;
      }
    }
    const pcm = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm.buffer;
  }

  const workletCode = `
    class Grabber extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) this.port.postMessage(ch.slice(0));
        return true;
      }
    }
    registerProcessor('grabber', Grabber);
  `;

  async function startRecording() {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const inRate = audioCtx.sampleRate;
    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    await audioCtx.audioWorklet.addModule(blobUrl);
    const src = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, "grabber");
    workletNode.port.onmessage = (e) => {
      const frame = e.data; // Float32Array at inRate
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      micBar.style.width = Math.min(100, rms * 320).toFixed(0) + "%";
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(floatTo16kPCM(frame, inRate));
      }
    };
    src.connect(workletNode);
    // The worklet must be in the audio graph to be pulled; route it to a
    // muted gain node so the user never hears their own mic.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    workletNode.connect(mute).connect(audioCtx.destination);
    wsSend(JSON.stringify({ type: "start_audio", sample_rate: TARGET_RATE }));
    recording = true;
    micBtn.classList.add("recording");
  }

  async function stopRecording() {
    recording = false;
    micBtn.classList.remove("recording");
    micBar.style.width = "0%";
    wsSend(JSON.stringify({ type: "stop_audio" }));
    if (workletNode) workletNode.disconnect();
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) await audioCtx.close();
    audioCtx = micStream = workletNode = null;
  }

  function toggleMic() {
    if (recording) {
      stopRecording();
    } else {
      startRecording().catch((err) => {
        showToast("Mic error: " + (err && err.message ? err.message : err));
      });
    }
  }
  micBtn.addEventListener("click", toggleMic);

  // --- status chip + companion banner ---------------------------------------
  // Real /api/session/{id}/state today returns {request_status, robot_id}
  // only (no battery/dock telemetry) -- the chip/banner below reflect that,
  // not the richer shape an earlier draft speculated about.
  function renderState(s) {
    const physical = !!s.robot_id;
    chip.className = "chip " + (physical ? "chip-physical" : "chip-virtual");
    chipMode.textContent = physical ? "physical" : "virtual";

    // Task 7 (virtual-pet grant): the sim is bound like any other robot (still
    // goes through the "physical" branch below, "Connected to turtlebotsim");
    // this badge is the only extra cue that the bound robot is virtual, not
    // the real turtlebot468 -- companion-banner strings stay untouched.
    if (virtualPetBadge) {
      virtualPetBadge.classList.toggle("hidden", s.robot_id !== "turtlebotsim");
    }

    banner.classList.remove("pending", "approved", "denied", "aborted");
    if (physical) {
      banner.classList.add("approved");
      bannerText.textContent = "Connected to " + s.robot_id + " 🐕 (physical)";
      requestBtn.disabled = true;
      requestBtn.textContent = "Connected";
    } else if (s.request_status === "pending") {
      banner.classList.add("pending");
      bannerText.textContent = "Request pending admin approval…";
      requestBtn.disabled = true;
      requestBtn.textContent = "Pending";
    } else if (s.request_status === "denied") {
      banner.classList.add("denied");
      bannerText.textContent = "Request denied by admin.";
      requestBtn.disabled = false;
      requestBtn.textContent = "Request physical companion";
    } else if (s.request_status === "aborted") {
      banner.classList.add("aborted");
      bannerText.textContent = "Session disconnected by admin — back to virtual.";
      requestBtn.disabled = false;
      requestBtn.textContent = "Request physical companion";
    } else {
      bannerText.textContent = "Virtual dog (avatar only)";
      requestBtn.disabled = false;
      requestBtn.textContent = "Request physical companion";
    }
  }

  let pollTimer = null;
  async function pollState() {
    if (!sessionId) return;
    try {
      const r = await fetch(`/api/session/${sessionId}/state`, { credentials: "same-origin" });
      if (!r.ok) throw new Error("no state");
      renderState(await r.json());
    } catch (e) {
      // Session row missing or endpoint unreachable -- quietly show the
      // virtual default rather than wedging the UI.
      chip.className = "chip chip-virtual";
      chipMode.textContent = "virtual";
    }
  }

  function startPolling() {
    pollState();
    clearInterval(pollTimer);
    pollTimer = setInterval(pollState, 3000);
  }

  requestBtn.addEventListener("click", async () => {
    requestBtn.disabled = true;
    try {
      const r = await fetch(`/api/session/${sessionId}/request-companion`, {
        method: "POST", credentials: "same-origin",
      });
      if (r.ok) {
        banner.classList.remove("denied", "aborted");
        banner.classList.add("pending");
        bannerText.textContent = "Request pending admin approval…";
        requestBtn.textContent = "Pending";
        return;
      }
    } catch (e) { /* network hiccup -- next poll will reconcile */ }
    requestBtn.disabled = false;
  });

  // --- intake ----------------------------------------------------------------
  async function beginSession(name, comfortable) {
    const resp = await fetch("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, comfortable }),
    });
    const data = await resp.json();
    sessionId = data.session_id;
    localStorage.setItem("guidemate_session_id", sessionId);
    localStorage.setItem("guidemate_name", name);
    showChat();
    connect();
    startPolling();
  }

  startBtn.addEventListener("click", () => {
    const name = nameInput.value.trim() || "friend";
    const comfortable = comfortableInput.checked;
    beginSession(name, comfortable).catch((err) => {
      showToast("Couldn't start a session: " + err.message);
    });
  });

  newSessionBtn.addEventListener("click", () => {
    // Clear only the local mirror -- the intake screen reappears. The old
    // session survives server-side (its transcript / lock are untouched).
    wsClosedByUs = true;
    if (ws) ws.close();
    clearInterval(pollTimer);
    localStorage.removeItem("guidemate_session_id");
    localStorage.removeItem("guidemate_name");
    location.reload();
  });

  if (sessionId) {
    showChat();
    connect();
    startPolling();
  }
})();
