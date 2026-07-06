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
  const stopBar = $("stop-bar");
  const stopBtn = $("stop-btn");
  const toast = $("toast");
  const soundToggle = $("sound-toggle");
  const soundLabel = $("sound-label");
  const voiceHint = $("voice-hint");
  const speakingIndicator = $("speaking-indicator");

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

  // ==========================================================================
  //  SAFE MARKDOWN  (dog bubbles only)
  // --------------------------------------------------------------------------
  //  Reply text is MODEL OUTPUT — semi-trusted. The security-critical rule is
  //  a strict, unbreakable ORDER:
  //
  //      (1) escapeHtml() the ENTIRE raw string FIRST, so every `<`, `>`, `"`,
  //         `'`, `&` the model emitted becomes an inert entity. After this
  //         step the string can contain NO live HTML.
  //      (2) THEN, and only then, apply a WHITELIST of formatting by inserting
  //         our own known-safe tags (<strong> <em> <code> <pre> <ul> <ol> <li>
  //         <p> <br> <a>). Every captured group we splice back in
  //         (link text, code, emphasis body) is a substring of the ALREADY
  //         escaped text, so it can never reintroduce a tag or an attribute
  //         breakout. Links only accept an http/https href (javascript:/data:
  //         etc. fall through and render literally).
  //
  //  Because of that order, this is the ONLY place we assign innerHTML from
  //  model text, and it is provably XSS-safe. NEVER call innerHTML on raw
  //  (un-escaped) model text anywhere else. User/transcript bubbles stay
  //  textContent (plain) — see addBubble().
  // ==========================================================================
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Inline formatting on an ALREADY-escaped line. Code spans are pulled out to
  // placeholders first so `*`/`_` inside them are left literal.
  function renderInline(escaped) {
    const codes = [];
    let s = escaped.replace(/`([^`]+)`/g, (_m, c) => {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    // Links: [text](url) — href whitelisted to http/https only. url is a
    // substring of the escaped text (quotes already &quot;), so it is
    // attribute-safe.
    s = s.replace(/\[([^\]]+)\]\((\S+?)\)/g, (m, txt, url) => {
      if (/^https?:\/\//i.test(url)) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>";
      }
      return m; // not an allowed scheme -> render literally
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?!\s)([^_]+?)_/g, "$1<em>$2</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => "<code>" + codes[i] + "</code>");
    return s;
  }

  function renderMarkdown(src) {
    const lines = escapeHtml(src).split(/\r?\n/); // ESCAPE FIRST (see banner)
    let out = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { // fenced code block
        i++;
        const buf = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // consume closing fence
        out += "<pre><code>" + buf.join("\n") + "</code></pre>";
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) { // unordered list
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push("<li>" + renderInline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>");
          i++;
        }
        out += "<ul>" + items.join("") + "</ul>";
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) { // ordered list
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push("<li>" + renderInline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
          i++;
        }
        out += "<ol>" + items.join("") + "</ol>";
        continue;
      }
      if (line.trim() === "") { i++; continue; }
      const para = [];
      while (
        i < lines.length && lines[i].trim() !== "" &&
        !/^\s*```/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i])
      ) { para.push(lines[i]); i++; }
      out += "<p>" + para.map(renderInline).join("<br>") + "</p>";
    }
    return out;
  }

  // The emote is metadata: it drives the avatar animation (armPendingEmote),
  // never rendered as text in the answer bubble. Signature keeps the `emote`
  // param for call-site compatibility but no dev label is printed.
  //
  // DOG bubbles render sanitized Markdown (renderMarkdown -> known-safe HTML).
  // YOU/transcript bubbles stay textContent (plain) — user text is never HTML.
  function addBubble(role, text) {
    const div = document.createElement("div");
    div.className = "bubble " + (role === "you" ? "you" : "dog");
    const body = document.createElement("div");
    body.className = "bubble-body";
    if (role === "you") {
      body.textContent = text;
    } else {
      body.innerHTML = renderMarkdown(text); // safe: escape-then-whitelist
    }
    div.appendChild(body);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  // --- "Moses is thinking…" indicator (bridges the 7-9s Bedrock round-trip) --
  let thinkingEl = null;
  function showThinking() {
    if (thinkingEl) return;
    thinkingEl = document.createElement("div");
    thinkingEl.className = "bubble dog thinking";
    thinkingEl.setAttribute("aria-label", "Moses is thinking");
    thinkingEl.innerHTML =
      '<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      "<span>Moses is thinking…</span>";
    messages.appendChild(thinkingEl);
    messages.scrollTop = messages.scrollHeight;
  }
  function hideThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  // --- per-message TTS replay ------------------------------------------------
  // The "audio" frame arrives just after its "reply" frame; we bind the audio
  // to the most recent dog bubble so the user can replay the spoken answer.
  let lastDogBubble = null;
  function attachReplay(bubble, url) {
    if (!bubble) return;
    let btn = bubble.querySelector(".bubble-replay");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bubble-replay";
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 8a5 5 0 0 1 0 8" /></svg>' +
        "<span>Replay</span>";
      bubble.appendChild(btn);
    }
    // Replay is an explicit user action -> plays regardless of the session
    // sound toggle (which only gates AUTOPLAY of new replies).
    btn.onclick = () => {
      player.src = url;
      player.play().catch(() => {});
    };
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

  function releasePendingEmote() {
    if (pendingEmote) {
      clearTimeout(pendingTimer);
      triggerEmote(pendingEmote);
      pendingEmote = null;
    }
  }

  // --- visible "speaking" state: a pulsing ring on the avatar + a caption for
  // the duration of TTS playback, tied to the <audio> play/ended/pause events.
  function setSpeaking(on) {
    avatar.classList.toggle("speaking", on);
    if (speakingIndicator) speakingIndicator.classList.toggle("hidden", !on);
  }

  // Emote/audio-sync contract preserved: the emote is still released on the
  // audio element's own "play" event. Speaking-ring is added here too.
  player.addEventListener("play", () => {
    setSpeaking(true);
    releasePendingEmote();
  });
  player.addEventListener("ended", () => setSpeaking(false));
  player.addEventListener("pause", () => setSpeaking(false));

  // --- session sound toggle (gates AUTOPLAY only; replay is always allowed) --
  let soundEnabled = localStorage.getItem("guidemate_sound") !== "0";
  function renderSound() {
    if (!soundToggle) return;
    soundToggle.setAttribute("aria-pressed", String(soundEnabled));
    if (soundLabel) soundLabel.textContent = soundEnabled ? "Sound on" : "Sound off";
    soundToggle.title = soundEnabled ? "Spoken replies on" : "Spoken replies muted";
  }
  if (soundToggle) {
    soundToggle.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem("guidemate_sound", soundEnabled ? "1" : "0");
      renderSound();
      if (!soundEnabled) { player.pause(); setSpeaking(false); }
    });
  }
  renderSound();

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
        // The thinking indicator was shown when recording stopped; keep it, but
        // move it below the just-added transcript so ordering reads correctly.
        if (thinkingEl) messages.appendChild(thinkingEl);
      } else if (msg.type === "reply") {
        hideThinking();
        lastDogBubble = addBubble("dog", msg.text);
        armPendingEmote(msg.emote);
      } else if (msg.type === "stopped") {
        showToast(msg.sent ? "Stop sent to the robot." : "Nothing to stop — no robot moving.");
      } else if (msg.type === "audio") {
        try {
          const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          // Always expose a replay control on the bubble...
          attachReplay(lastDogBubble, url);
          if (soundEnabled) {
            // ...but only AUTOPLAY when the session sound toggle is on.
            player.src = url;
            player.play().catch(() => releasePendingEmote());
          } else {
            releasePendingEmote(); // muted: don't leave the avatar waiting
          }
        } catch (e) {
          releasePendingEmote();
        }
      } else if (msg.type === "error") {
        hideThinking();
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
    showThinking();
    wsSend(JSON.stringify({ type: "text", message: text }));
  });

  // --- quick-action chips: prefill the composer (Moses concierge affordances).
  // Prefill-only (not auto-send) so the user reviews before sending -- reuses
  // the existing form submit path, no new protocol.
  document.querySelectorAll(".chip-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prompt = btn.getAttribute("data-prompt") || btn.textContent.trim();
      input.value = prompt;
      input.focus();
    });
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
    if (voiceHint) voiceHint.classList.remove("hidden");
  }

  async function stopRecording() {
    recording = false;
    micBtn.classList.remove("recording");
    micBar.style.width = "0%";
    if (voiceHint) voiceHint.classList.add("hidden");
    // Voice turn: STT + Bedrock is now in flight -> show the thinking cue.
    showThinking();
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
    // The virtual pet (sim) is bound like a robot but has no real motion; it is
    // NOT a physical connection. Treat it as its own authoritative state.
    const isPet = s.robot_id === "turtlebotsim";
    const physicalMotion = physical && !isPet;

    // Single authoritative connection pill (no contradictory "physical" +
    // "Virtual pet" at once): the virtual-pet badge OWNS the header state when
    // the sim is bound, so the status chip is hidden in that case.
    if (virtualPetBadge) {
      virtualPetBadge.classList.toggle("hidden", !isPet);
    }
    if (isPet) {
      chip.classList.add("hidden");
    } else {
      chip.className = "chip " + (physical ? "chip-physical" : "chip-virtual");
      chipMode.textContent = physical ? "physical" : "virtual";
    }

    // Persistent Stop: visible only while REAL robot motion can be active
    // (a bound physical robot — not virtual, not the motion-less sim pet).
    if (stopBar) stopBar.classList.toggle("hidden", !physicalMotion);

    // The "Connected" request button reads as a green success chip when bound.
    requestBtn.classList.toggle("is-connected", physical);

    banner.classList.remove("pending", "approved", "denied", "aborted");
    if (physical) {
      banner.classList.add("approved");
      // Flat monochrome status is carried by the banner dot; no emoji glyph.
      // One authoritative label: the motion-less sim reads "(virtual pet)", a
      // real robot reads "(physical)" -- never both cues at once.
      bannerText.textContent =
        "Connected to " + s.robot_id + (isPet ? " (virtual pet)" : " (physical)");
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
      if (stopBar) stopBar.classList.add("hidden");
      if (virtualPetBadge) virtualPetBadge.classList.add("hidden");
      requestBtn.classList.remove("is-connected");
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

  // --- persistent Stop: send a real stop command to the bound robot ---------
  // The button is only shown while a physical robot is connected (renderState),
  // but we defend in depth here too. The backend WS handler resolves the
  // session's bound robot and forwards a Command(type="stop") to it.
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      wsSend(JSON.stringify({ type: "stop" }));
    });
  }

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
