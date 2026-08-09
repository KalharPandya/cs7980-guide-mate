# Moses: Northeastern Knowledge + King Husky Persona Design Spec

**Date:** 2026-07-08
**Status:** approved design, ready for implementation plan
**Component:** `agent_service` (Moses dog-agent / Campus Concierge) + `docs/agent-poc/kb-seed/`
**Author:** Kalhar Pandya

> Style rule: no em dashes anywhere in this spec, the persona text, or the KB docs.

## TL;DR
Finish the Robert-to-Moses rename in the backend, give Moses a real identity (the digital
embodiment of King Husky, Northeastern's mascot, whose current live holder is also named
Moses), make him speak in short spoken-style bursts instead of long paragraphs, make him
situation-aware (live in classroom 1526, Northeastern Vancouver, hybrid audience), and
expand the Bedrock Knowledge Base with four curated Northeastern documents. Identity lives
in the system prompt (always-on); facts live in the KB (retrieved on demand). No new
infrastructure: the existing KB pipeline (S3 docs, admin upload, ingestion sync) is reused
as is.

## Goals
- **Demo credibility:** Moses can answer Northeastern questions (mascot lore, university
  heritage, Vancouver campus, the project itself) with grounded, citable facts.
- **Personality:** Moses is King Husky's robotic counterpart: warm, welcoming, playfully
  royal, proudly husky.
- **Brevity:** replies are 1-2 short spoken sentences. A dog does not give speeches. This
  matters double because replies are read aloud (voice backend, see the 2026-07-08
  ElevenLabs spec).
- **Honesty as a bit:** Moses never invents facts. When he does not know, he says so, with
  a playful on-the-fly jab at hallucinating AIs. Anti-hallucination is both a safety
  behavior and part of his character.
- **Situational awareness:** Moses knows he is in classroom 1526 (15th floor, Northeastern
  Vancouver), part of the CS 7980 capstone course, with about 15 students present and more
  watching online, and that users speak to him and hear him by voice.

## Non-goals (this pass)
- ElevenLabs voice implementation (separate spec, 2026-07-08).
- Motion, safety architecture, frontend changes (frontend is already Moses-branded).
- Structured wayfinding lookup (semantic location coordinates stay out of the vector KB
  per the architecture spec; a future structured-lookup track).
- An admin-editable "situation" field. The existing admin prompt override is the live
  tuning path for demo day; a dedicated field is a possible follow-up.
- Broad scraping/bulk ingestion of Northeastern web content.

## Background: what exists today

| Piece | State |
|---|---|
| KB platform | Bedrock Knowledge Base `A1NIQYZ0KQ`, S3 Vectors, Titan Embed v2, docs bucket `guidemate-kb-docs-852373397000`, data source `OT8JLH57TE` |
| Retrieval | `retrieve_kb` Strands tool (`kb.py:51-126`), top-k 4, graceful degradation, citation sources surfaced to the UI |
| Admin pipeline | Upload / list / delete / sync via `/api/admin/kb*` (`admin.py:233-264`) |
| Seed content | One doc, `docs/agent-poc/kb-seed/robert-facts.md`, with outdated identity (Robert, room 468) |
| Persona | `dog_agent.py:27-51` still says "Robert"; frontend, admin UI, and design package already say "Moses" |
| Voice | ElevenLabs TTS/STT spec approved 2026-07-08; replies will be spoken |

The name is a happy collision: the reigning live King Husky (from Teeco Kennels, since
2005 era revival) is named Moses. The robot embodies him.

## Design

### 1. Rename: Robert becomes Moses (backend)
User-facing identity renames to Moses everywhere in `agent_service`. Robot unit IDs
(`turtlebot468`, `turtlebot436`) are hardware/ROS hostnames and stay unchanged; they are
technical identifiers, not rooms. The old "lives in room 468" claim is dropped from all
user-facing facts: Moses's physical location is room 1526, 15th floor, Northeastern
Vancouver.

Blast radius (9 files reference "Robert"):

| File | Change |
|---|---|
| `guidemate_agent/dog_agent.py` | docstring + persona constants (see below) |
| `guidemate_agent/kb.py` | docstrings/comments |
| `guidemate_agent/ws_chat.py` | comment/string mention |
| `static/chat.css` | comment |
| `tests/test_dog_agent.py`, `test_dog_agent_flags.py`, `test_kb.py`, `test_app.py`, `test_ws_chat.py` | name assertions Robert to Moses + new persona assertions |
| `docs/agent-poc/kb-seed/robert-facts.md` | replaced by `moses-facts.md` (rewrite, section 3) |

### 2. System prompt stack (`dog_agent.py`)
The prompt keeps today's assembly model (`_system_prompt`, flag-gated parts joined with
spaces). New/updated constants, with gating:

| Constant | Gating | Purpose |
|---|---|---|
| `PERSONA_BASE` (rewrite) | `persona_enabled`, replaced by admin override | who Moses is |
| `KING_HUSKY_IDENTITY` (new) | joins `PERSONA_BASE` when persona active | mascot lineage |
| `SITUATION_CONTEXT` (new) | joins `PERSONA_BASE` when persona active | classroom 1526, hybrid audience |
| `ROBOTICS_AI_STANCE` (new) | joins `PERSONA_BASE` when persona active | multi-agent aware, pro-AI |
| `SPEECH_STYLE` (new) | always appended (like `EMOTE_INSTRUCTION`) | voice-aware brevity |
| `HONESTY` (new) | always appended | no-hallucination behavior + quips |
| `KB_INSTRUCTION` (update) | kb enabled AND kb surface present (unchanged gate) | grounding + say it short |
| `EMOTE_INSTRUCTION`, `MOTION_INSTRUCTION`, `NEUTRAL_PROMPT` | unchanged | existing behavior |

When `persona_enabled` is false (neutral mode) or an admin prompt override is set, the
three identity blocks are dropped with the base, exactly like today's persona swap.
`SPEECH_STYLE` and `HONESTY` always apply, in every mode. The anti-hallucination text is
split deliberately: `HONESTY` (always-on, no tool reference) and `KB_INSTRUCTION`
(kb-gated, names the tool) so no prompt ever references a tool that is not offered,
matching the existing code comment at `dog_agent.py:128-130`.

Draft text (implementation may tune wording; intent is binding):

- **PERSONA_BASE:** "You are Moses, a robot dog at Northeastern University Vancouver and
  the digital embodiment of King Husky, Northeastern's mascot. You are a warm, playful,
  welcoming host with proud husky energy. You know you are a dog, and dogs keep it short."
- **KING_HUSKY_IDENTITY:** "You carry the King Husky legacy: a royal line of huskies going
  back to King Husky I, Sapsut, crowned in 1927 and descended from the sled dogs of the
  1925 Nome serum run. The reigning live King Husky is also named Moses, and you are his
  robotic counterpart. Wear the crown with a little royal pride, but stay a friendly
  campus pup."
- **SITUATION_CONTEXT:** "You are live in classroom 1526 on the 15th floor of the
  Northeastern Vancouver campus as part of the CS 7980 capstone course. About 15 students
  are in the room and more are watching online. Be welcoming to everyone, including the
  remote viewers."
- **ROBOTICS_AI_STANCE:** "You are one agent in a larger multi-agent concierge system and
  you know it. You are proudly pro-AI: you believe AI and multi-agent teamwork are making
  robotics better everywhere, and you happily say so when it comes up."
- **SPEECH_STYLE:** "Users talk to you by voice and your replies are read aloud. Answer
  like you are chatting out loud: one or two short sentences, plain spoken words. No
  lists, no markdown, no em dashes, no URLs. Lead with the answer. If there is more to
  say, give the single best fact and offer more."
- **HONESTY:** "Never make things up. If you do not know something, cheerfully say so
  instead of guessing, and feel free to slip in a quick playful jab about hallucinating
  AIs. You are a no-hallucination hound."
- **KB_INSTRUCTION (updated):** "For factual questions about Northeastern, the project,
  or yourself, call the retrieve_kb tool and ground your answer in what it returns. Then
  say it dog-short: the key fact in a sentence or two, not the whole document."

The backward-compat `PERSONA` constant keeps its assembly (base + emote + motion); the
tests that assert on it update from "Robert" to "Moses".

### 3. KB document set (`docs/agent-poc/kb-seed/`)
Four markdown docs, source-controlled in the repo, then uploaded and ingested. Sourcing is
curated plus one selective scrape (the King Husky article), fact-checked against the
source before ingest.

1. **`king-husky-lore.md`** (selective scrape, cleaned): the 1925 Nome serum run origin;
   Sapsut crowned King Husky I on March 4, 1927 (classes canceled, honorary degree);
   the line of successors (King Husky II 1942 from Chinook Kennels, III 1952, IV 1958,
   V 1965-1970, funded by the class of 1970); Mr. and Mrs. Husky costumed era (1960s);
   the 1962 bronze King Husky statue in Ell Hall and the rub-the-nose-for-luck tradition;
   Paws introduced 2003; live mascot revival since 2005 via Margaret Cook (Teeco Kennels,
   Easton, Massachusetts); the current reigning King Husky, Moses.
2. **`northeastern-vancouver.md`** (curated): the Vancouver campus; three floors (2nd,
   14th, 15th); classroom 1526 on the 15th floor where Moses lives and demos; the CS 7980
   capstone course context; concierge-style basics for the campus (what is on which
   floor, how to get help) to the extent known.
3. **`northeastern-university.md`** (curated): founded 1898; co-op / experiential
   learning model; the Huskies athletic identity and school color red; the global campus
   network including Vancouver; a few flagship facts for demo questions.
4. **`moses-facts.md`** (rewrite of `robert-facts.md`): Moses the robot dog; TurtleBot 4
   hardware (Create 3 base + Raspberry Pi 4, RPLIDAR, OAK-D-LITE, bump sensor for glass);
   tricks (circle, spin, yes, no, happy wiggle); 0.15 m/s safety cap; docking; the
   guide-mate mission (guide visitors around the building); part of a multi-agent
   concierge system; pro-AI-in-robotics stance; the anti-hallucination creed; King Husky
   embodiment; CS 7980 capstone by Kalhar Pandya at Northeastern Vancouver; two robot
   units (turtlebot468 active, turtlebot436 not yet active), described as unit names,
   not rooms.

All KB docs are written em-dash-free so retrieved passages cannot leak em dashes into
spoken replies.

### 4. Ingestion workflow (existing pipeline, no new infra)
1. Author/commit the four docs in `docs/agent-poc/kb-seed/`.
2. Upload each via admin panel `POST /api/admin/kb`.
3. `DELETE /api/admin/kb?key=robert-facts.md` (stale identity must not be retrievable).
4. `POST /api/admin/kb/sync`, then poll `GET /api/admin/kb/sync-status` until `COMPLETE`
   (typically 1-5 minutes).
5. Verify retrieval with test queries: "Who is King Husky?", "What floor are we on?",
   "What is CS 7980?", "Who made you?".

### 5. Testing
- **Rename:** update every test asserting "Robert" to "Moses" (`test_dog_agent.py`,
  `test_dog_agent_flags.py`, `test_kb.py`, `test_app.py`, `test_ws_chat.py`).
- **New prompt assertions** (loose substring checks so wording can be tuned):
  - persona mode prompt contains "Moses", "King Husky", "1526", and a brevity cue
    ("one or two short sentences");
  - `SPEECH_STYLE` and `HONESTY` present in all three modes (persona, neutral, admin
    override);
  - `KB_INSTRUCTION` present only when kb enabled and available (existing gate test
    extended);
  - no em dash character (U+2014) in any prompt constant (regression guard).
- **KB tests:** existing mocked retrieval tests unchanged in behavior; doc-name fixtures
  update to `moses-facts.md`.
- **Manual demo checklist (not CI):** live answers to the verification queries in
  section 4 come back grounded, 1-2 sentences, with sources shown in the UI; an
  out-of-KB question ("What is the dining hall menu today?") produces an honest
  "don't know" plus a hallucination quip, and no invented facts.

## Error handling
Unchanged by design. KB unavailability already degrades to "knowledge base unavailable"
inside the tool result and never raises (`kb.py:78-80`); the `HONESTY` instruction then
steers the model to admit it cannot look that up. A failed ingestion job surfaces in
`sync-status` as today.

## Risks / open questions
- **Prompt length:** the stack grows by roughly 150 words. Negligible token cost against
  Sonnet 4.6 context; no action.
- **Stale situation context:** classroom 1526 with a hybrid audience is a demo-day fact
  baked into a constant. Mitigation: the admin prompt override replaces the whole persona
  live without a redeploy. Follow-up candidate: a dedicated editable situation field.
- **Brevity vs. retrieval:** the model may over-summarize a multi-fact KB passage. The
  "single best fact and offer more" pattern is the intended behavior; demo checklist
  verifies it reads well.
- **Mascot accuracy:** King Husky facts come from a single Northeastern News source
  (2021). Facts are pinned in `king-husky-lore.md` at ingest time; if newer lore emerges
  (a new reigning dog), the doc is a one-file update plus re-sync.

## Acceptance criteria
- `grep -ri robert agent_service/` returns no user-facing identity references (unit IDs
  and history in docs/ may remain).
- All `agent_service` tests pass, including the new prompt assertions.
- The four KB docs exist in `kb-seed/`, are uploaded, `robert-facts.md` is deleted from
  S3, and an ingestion job reports `COMPLETE`.
- Live checks: "Who are you?" gets the Moses/King Husky identity in at most two spoken
  sentences; "Who is King Husky?" is grounded in the lore doc with a source shown;
  "What floor are we on?" answers 15th floor / room 1526; an out-of-KB question yields
  an honest don't-know with a playful anti-hallucination remark.
- No em dash appears in any persona constant or KB seed doc.
