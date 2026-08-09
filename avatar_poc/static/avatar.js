// Live-avatar POC — drives the SVG dog: viseme lip-sync + emote animations.
// The mouth is a single <ellipse id="mouth"> whose rx/ry we snap per viseme
// (snapping at viseme rate reads as talking; morphing is unnecessary).

const $ = (id) => document.getElementById(id);
const mouth = $("mouth"), teeth = $("teeth"), tongue = $("tongue");
const dog = $("dog"), tailGroup = $("tailGroup"), lidL = $("lidL"), lidR = $("lidR");

// Mouth shapes: rx/ry of the mouth ellipse, plus whether teeth/tongue show.
const SHAPES = {
  closed:   { rx: 20, ry: 2,  teeth: false },
  slight:   { rx: 17, ry: 6,  teeth: false },
  open:     { rx: 18, ry: 15, teeth: false },
  wideopen: { rx: 21, ry: 22, teeth: false },
  wide:     { rx: 27, ry: 6,  teeth: false }, // "ee"
  round:    { rx: 12, ry: 14, teeth: false }, // "oo"
  f:        { rx: 20, ry: 4,  teeth: true  }, // f / v — teeth on lip
  s:        { rx: 16, ry: 5,  teeth: true  }, // s / t / th
};

// Polly viseme value -> mouth shape. Covers Polly's full viseme set.
const VISEME_MAP = {
  sil: "closed", p: "closed",
  f: "f", T: "s", s: "s", t: "s", S: "round", k: "slight", r: "slight",
  i: "wide", e: "open", E: "open", "@": "open", a: "wideopen",
  o: "round", O: "round", u: "round",
};

function setMouth(shapeKey) {
  const s = SHAPES[shapeKey] || SHAPES.closed;
  mouth.setAttribute("rx", s.rx);
  mouth.setAttribute("ry", s.ry);
  teeth.setAttribute("opacity", s.teeth ? "0.9" : "0");
}

// ---- lip-sync: schedule mouth against audio playback ----
let rafId = null;
function lipSync(audio, visemes) {
  cancelAnimationFrame(rafId);
  let i = 0;
  const tick = () => {
    if (audio.paused || audio.ended) { setMouth("closed"); return; }
    const t = audio.currentTime * 1000;
    while (i < visemes.length && visemes[i].time <= t) i++;
    const cur = visemes[Math.max(0, i - 1)];
    setMouth(cur ? VISEME_MAP[cur.value] || "open" : "closed");
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// ---- emotes (Web Animations API) — same vocabulary as the robot ----
const EASE = "cubic-bezier(.34,1.56,.64,1)";
function playEmote(name) {
  switch (name) {
    case "yes": // nod
      dog.animate(
        [{ transform: "rotate(0deg) translateY(0)" },
         { transform: "rotate(0deg) translateY(10px)" },
         { transform: "rotate(0deg) translateY(0)" }],
        { duration: 340, iterations: 2, easing: "ease-in-out" });
      break;
    case "no": // shake
      dog.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(-9deg)" },
         { transform: "rotate(9deg)" }, { transform: "rotate(0deg)" }],
        { duration: 260, iterations: 3, easing: "ease-in-out" });
      break;
    case "happy": // wiggle + bounce, tongue out, fast tail
      dog.animate(
        [{ transform: "rotate(-5deg) scale(1)" },
         { transform: "rotate(5deg) scale(1.05)" },
         { transform: "rotate(-4deg) scale(1)" },
         { transform: "rotate(0deg) scale(1)" }],
        { duration: 700, iterations: 2, easing: EASE });
      tongue.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 1 }, { opacity: 0 }],
        { duration: 1400, easing: "ease-in-out" });
      wagFast();
      break;
    case "circle": // one full turn (screen analog of the robot drawing a circle)
      dog.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: 1400, easing: "ease-in-out" });
      break;
    case "spin": // fast multi-turn
      dog.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(1080deg)" }],
        { duration: 1500, easing: "cubic-bezier(.5,0,.5,1)" });
      break;
  }
}

// ---- idle ambient life: tail wag, blink, breathe ----
let wagAnim = tailGroup.animate(
  [{ transform: "rotate(-8deg)" }, { transform: "rotate(8deg)" }],
  { duration: 900, direction: "alternate", iterations: Infinity, easing: "ease-in-out" });
function wagFast() {
  wagAnim.cancel();
  tailGroup.animate([{ transform: "rotate(-16deg)" }, { transform: "rotate(16deg)" }],
    { duration: 180, direction: "alternate", iterations: 8, easing: "ease-in-out" })
    .onfinish = startIdleWag;
}
function startIdleWag() {
  wagAnim = tailGroup.animate(
    [{ transform: "rotate(-8deg)" }, { transform: "rotate(8deg)" }],
    { duration: 900, direction: "alternate", iterations: Infinity, easing: "ease-in-out" });
}
function blink() {
  [lidL, lidR].forEach((lid) =>
    lid.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" },
                 { transform: "scaleY(0)" }], { duration: 180, easing: "ease-in-out" }));
}
function scheduleBlink() {
  blink();
  setTimeout(scheduleBlink, 2200 + Math.random() * 2600);
}
dog.animate([{ transform: "translateY(0)" }, { transform: "translateY(-3px)" },
             { transform: "translateY(0)" }],
  { duration: 3200, iterations: Infinity, easing: "ease-in-out" });

// ---- speak: fetch Polly audio + visemes, play, lip-sync, emote ----
// Guard is held until the utterance actually ENDS (not when play() resolves),
// and any prior utterance is torn down first, so rapid clicks can never stack
// overlapping voices or dueling lip-sync loops onto the single shared mouth.
let busy = false;
let current = null; // the currently-playing Audio, if any

function stopCurrent() {
  cancelAnimationFrame(rafId);
  if (current) { current.pause(); current.src = ""; current = null; }
  setMouth("closed");
}

async function speak(emote) {
  if (busy) return;
  busy = true;
  const btn = $("say"); btn.disabled = true;
  setStatus("");
  stopCurrent();
  const release = () => { busy = false; btn.disabled = false; };
  try {
    const res = await fetch("/api/say", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: $("text").value, emote, voice: $("voice").value, engine: "neural",
      }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    if (emote && emote !== "idle") playEmote(emote);
    const audio = new Audio("data:audio/mpeg;base64," + data.audio_b64);
    current = audio;
    const finish = () => {
      if (current === audio) current = null;
      cancelAnimationFrame(rafId);
      setMouth("closed");
      release();
    };
    audio.addEventListener("play", () => lipSync(audio, data.visemes));
    audio.addEventListener("ended", finish);
    audio.addEventListener("error", finish);
    await audio.play(); // guard stays held until ended/error fires
  } catch (e) {
    setStatus("error: " + e.message, true);
    current = null;
    release();
  }
}

function setStatus(msg, err) {
  const s = $("status"); s.textContent = msg; s.classList.toggle("err", !!err);
}

// ---- wiring ----
$("say").addEventListener("click", () => speak("idle"));
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter") speak("idle"); });
document.querySelectorAll(".emotes button").forEach((b) =>
  b.addEventListener("click", () => speak(b.dataset.emote)));

(async function health() {
  const el = $("health");
  try {
    const h = await (await fetch("/api/health")).json();
    const ok = h.status === "ok" && h.polly;
    el.textContent = ok ? "ready" : "polly unreachable";
    el.className = "health " + (ok ? "ok" : "bad");
  } catch {
    el.textContent = "backend down"; el.className = "health bad";
  }
})();
setMouth("closed");
scheduleBlink();
