"""Unit tests for DogAgent's tool-closure body — no Bedrock, no network."""

from guidemate_msgs.messages import Ack

from guidemate_agent import dog_agent, sessions
from guidemate_agent.dog_agent import DogAgent, PERSONA
from guidemate_agent.store import DEFAULT_FLAGS


class FakeRegistry:
    """Registry stand-in whose send_command always reports the robot unreachable."""

    def send_command(self, robot_id, cmd, timeout_s=5.0):
        return []


def test_emote_impl_returns_napping_offline_when_no_acks():
    agent = DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )
    captured = {"emote": None, "acks": []}

    result = agent._emote_impl("happy", target="turtlebot468", captured=captured)

    assert result == "robot did not respond — I'm probably napping offline"
    assert captured["emote"] == "happy"
    assert captured["acks"] == []


def test_emote_impl_returns_napping_offline_when_no_target():
    agent = DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=[],
    )
    captured = {"emote": None, "acks": []}

    result = agent._emote_impl("no", target=None, captured=captured)

    assert result == "robot did not respond — I'm probably napping offline"
    assert captured["emote"] == "no"
    assert captured["acks"] == []


class ScriptedRegistry:
    """Registry stand-in returning a scripted ack list; records get_status calls."""

    def __init__(self, acks=None, status=None):
        self._acks = acks or []
        self._status = status or {"robot_id": "turtlebot468", "presence": "unknown"}
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        self.sent.append((robot_id, cmd))
        return list(self._acks)

    def get_status(self, robot_id):
        return dict(self._status)


def _agent(registry):
    return DogAgent(
        registry=registry,
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )


def _captured():
    return {"emote": None, "acks": []}


def test_motion_impl_refused_docked():
    acks = [Ack(cmd_id="c", state="received", simulated=False),
            Ack(cmd_id="c", state="failed", reason="docked", simulated=False,
                gates={"docked": True, "motion_enabled": True, "dry_run": False})]
    reg = ScriptedRegistry(acks=acks)
    captured = _captured()
    result = _agent(reg)._motion_impl("spin", target="turtlebot468", captured=captured)
    assert result == "the robot refused: it is docked"
    assert captured["acks"][-1]["reason"] == "docked"
    assert reg.sent[0][1].type == "motion"


def test_motion_impl_refused_motion_disabled():
    acks = [Ack(cmd_id="c", state="failed", reason="motion_disabled", simulated=False)]
    result = _agent(ScriptedRegistry(acks=acks))._motion_impl(
        "circle", target="turtlebot468", captured=_captured())
    assert result == "the robot refused: motion is disabled"


def test_motion_impl_simulated_done():
    acks = [Ack(cmd_id="c", state="done", simulated=True,
                gates={"docked": None, "motion_enabled": False, "dry_run": True})]
    result = _agent(ScriptedRegistry(acks=acks))._motion_impl(
        "spin", target="turtlebot468", captured=_captured())
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_motion_impl_unknown_trick_never_sent():
    reg = ScriptedRegistry()
    result = _agent(reg)._motion_impl("moonwalk", target="turtlebot468",
                                      captured=_captured())
    assert result == "unknown trick — I only know 'circle' and 'spin'"
    assert reg.sent == []  # invalid name rejected client-side, nothing published


def test_motion_impl_offline():
    result = _agent(ScriptedRegistry(acks=[]))._motion_impl(
        "spin", target="turtlebot468", captured=_captured())
    assert result == "robot did not respond — I'm probably napping offline"


# --- run_motion must only accept the trick vocabulary it advertises to the
# model (circle/spin), even though "dock"/"undock"/"forward" are valid names
# in the wire schema's _MOTION_NAMES for the separate admin/assignment
# dock-undock flow. Without this check those names pass Command's validator
# and get dispatched to the registry -- a chat-LLM path to real robot motion
# the tool's own contract (MOTION_INSTRUCTION) says it can't do. ---
def test_motion_impl_rejects_undock_never_sent():
    reg = ScriptedRegistry()
    result = _agent(reg)._motion_impl("undock", target="turtlebot468",
                                      captured=_captured())
    assert result == "unknown trick — I only know 'circle' and 'spin'"
    assert reg.sent == []


def test_motion_impl_rejects_dock_never_sent():
    reg = ScriptedRegistry()
    result = _agent(reg)._motion_impl("dock", target="turtlebot468",
                                      captured=_captured())
    assert result == "unknown trick — I only know 'circle' and 'spin'"
    assert reg.sent == []


def test_motion_impl_rejects_forward_never_sent():
    reg = ScriptedRegistry()
    result = _agent(reg)._motion_impl("forward", target="turtlebot468",
                                      captured=_captured())
    assert result == "unknown trick — I only know 'circle' and 'spin'"
    assert reg.sent == []


def test_motion_impl_still_dispatches_circle():
    acks = [Ack(cmd_id="c", state="done", simulated=True)]
    reg = ScriptedRegistry(acks=acks)
    result = _agent(reg)._motion_impl("circle", target="turtlebot468",
                                      captured=_captured())
    assert reg.sent[0][1].type == "motion"
    assert reg.sent[0][1].name == "circle"
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_motion_impl_still_dispatches_spin():
    acks = [Ack(cmd_id="c", state="done", simulated=True)]
    reg = ScriptedRegistry(acks=acks)
    result = _agent(reg)._motion_impl("spin", target="turtlebot468",
                                      captured=_captured())
    assert reg.sent[0][1].type == "motion"
    assert reg.sent[0][1].name == "spin"
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_stop_impl_sends_stop_command():
    acks = [Ack(cmd_id="c", state="done", simulated=True)]
    reg = ScriptedRegistry(acks=acks)
    result = _agent(reg)._stop_impl(target="turtlebot468", captured=_captured())
    assert reg.sent[0][1].type == "stop"
    assert reg.sent[0][1].name == "stop"
    assert result == "delivered (simulated — dry-run, the robot stayed still)"


def test_status_impl_returns_registry_status_json():
    import json as _json
    status = {"robot_id": "turtlebot468", "presence": "online", "battery": 0.9,
              "docked": True, "gates": {"docked": True, "motion_enabled": False,
                                        "dry_run": True}}
    result = _agent(ScriptedRegistry(status=status))._status_impl("turtlebot468")
    assert _json.loads(result)["battery"] == 0.9


def test_persona_mentions_new_tools_and_docked_rule():
    assert "run_motion" in PERSONA
    assert "docked" in PERSONA


# =====================================================================
# Phase-4 Task 4: session awareness — user name, last-10 history, and
# lock-gated virtual/physical tools.
# =====================================================================


class RecordingRegistry:
    """Records every published command; acks it received -> done (simulated)."""

    def __init__(self):
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0):
        self.sent.append((robot_id, cmd.type, cmd.name))
        return [
            Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=True),
        ]

    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "unknown"}


# --- lock-gated emote: virtual (avatar only) vs physical (published) ---
def test_virtual_emote_does_not_publish():
    reg = RecordingRegistry()
    agent = _agent(reg)
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("happy", target="turtlebot468", captured=captured,
                            physical=False)
    assert reg.sent == []                       # nothing published to MQTT
    assert captured["emote"] == "happy"         # UI still animates the avatar
    assert captured["acks"] == []
    assert "virtual" in out.lower()


def test_physical_emote_publishes():
    reg = RecordingRegistry()
    agent = _agent(reg)
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("yes", target="turtlebot468", captured=captured,
                            physical=True)
    assert reg.sent == [("turtlebot468", "emote", "yes")]
    assert captured["emote"] == "yes"
    assert captured["acks"] and captured["acks"][-1]["state"] == "done"
    assert "simulated" in out.lower() or "delivered" in out.lower()


# --- Task 5.3: GUIDEMATE_EMOTE_MIRROR_ROBOT_ID mirrors virtual emotes onto a
# physical robot, best-effort. Unset = feature off (regression guard); set =
# also publish; a registry exception on the mirror publish is swallowed.
def test_virtual_emote_mirror_unset_no_registry_call(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_EMOTE_MIRROR_ROBOT_ID", raising=False)
    reg = RecordingRegistry()
    agent = _agent(reg)
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("happy", target="turtlebot468", captured=captured,
                            physical=False)
    assert reg.sent == []                       # unchanged: nothing published
    assert captured["emote"] == "happy"
    assert captured["acks"] == []
    assert "virtual" in out.lower()


def test_virtual_emote_mirror_set_also_publishes_to_mirror_robot(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_EMOTE_MIRROR_ROBOT_ID", "turtlebot468")
    reg = RecordingRegistry()
    agent = _agent(reg)
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("happy", target="turtlebot468", captured=captured,
                            physical=False)
    assert reg.sent == [("turtlebot468", "emote", "happy")]
    assert captured["emote"] == "happy"
    # mirror acks are not folded into this (virtual) turn's UI state
    assert captured["acks"] == []
    assert "virtual" in out.lower()


def test_virtual_emote_mirror_publish_failure_is_swallowed(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_EMOTE_MIRROR_ROBOT_ID", "turtlebot468")

    class ExplodingRegistry:
        def send_command(self, robot_id, cmd, timeout_s=5.0):
            raise RuntimeError("mqtt broker unreachable")

    agent = _agent(ExplodingRegistry())
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("no", target="turtlebot468", captured=captured,
                            physical=False)
    assert captured["emote"] == "no"
    assert captured["acks"] == []
    assert out == "virtual emote played (avatar only — not connected to a robot)"


def test_physical_emote_unaffected_by_mirror_var(monkeypatch):
    """Regression guard: the mirror var must not alter the physical=True branch."""
    monkeypatch.setenv("GUIDEMATE_EMOTE_MIRROR_ROBOT_ID", "some-other-robot")
    reg = RecordingRegistry()
    agent = _agent(reg)
    captured = {"emote": None, "acks": []}
    out = agent._emote_impl("yes", target="turtlebot468", captured=captured,
                            physical=True)
    # only the real target is published to -- no mirror call added
    assert reg.sent == [("turtlebot468", "emote", "yes")]
    assert captured["acks"] and captured["acks"][-1]["state"] == "done"
    assert "simulated" in out.lower() or "delivered" in out.lower()


# --- adversarial-review fix: mirror publishes are rate-limited per robot id so
# a burst of emotes from multiple concurrent virtual sessions can't spam the
# one physical mirror robot faster than _EMOTE_MIRROR_MIN_INTERVAL_S. The
# virtual session's own reply must always succeed regardless of throttling.
def test_virtual_emote_mirror_rate_limit_skips_second_publish_in_window(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_EMOTE_MIRROR_ROBOT_ID", "turtlebot468")
    reg = RecordingRegistry()
    agent = _agent(reg)
    fake_now = [100.0]
    monkeypatch.setattr(dog_agent.time, "monotonic", lambda: fake_now[0])

    out1 = agent._emote_impl("happy", target="turtlebot468",
                             captured={"emote": None, "acks": []}, physical=False)
    assert reg.sent == [("turtlebot468", "emote", "happy")]
    assert "virtual" in out1.lower()

    # 1s later -- still inside the 2.0s window, so the mirror must be skipped,
    # but the virtual session's own reply must be unaffected.
    fake_now[0] += 1.0
    captured2 = {"emote": None, "acks": []}
    out2 = agent._emote_impl("yes", target="turtlebot468", captured=captured2,
                             physical=False)
    assert reg.sent == [("turtlebot468", "emote", "happy")]  # registry not called again
    assert captured2["emote"] == "yes"
    assert captured2["acks"] == []
    assert "virtual" in out2.lower()


def test_virtual_emote_mirror_publishes_again_after_window_elapses(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_EMOTE_MIRROR_ROBOT_ID", "turtlebot468")
    reg = RecordingRegistry()
    agent = _agent(reg)
    fake_now = [200.0]
    monkeypatch.setattr(dog_agent.time, "monotonic", lambda: fake_now[0])

    agent._emote_impl("happy", target="turtlebot468",
                      captured={"emote": None, "acks": []}, physical=False)
    assert reg.sent == [("turtlebot468", "emote", "happy")]

    fake_now[0] += 2.1  # past _EMOTE_MIRROR_MIN_INTERVAL_S
    agent._emote_impl("no", target="turtlebot468",
                      captured={"emote": None, "acks": []}, physical=False)
    assert reg.sent == [
        ("turtlebot468", "emote", "happy"),
        ("turtlebot468", "emote", "no"),
    ]


# --- system prompt: user name + last-10-message recap ---
def test_system_prompt_includes_name_and_history():
    agent = _agent(RecordingRegistry())
    prompt = agent._build_system_prompt(
        "Ada", [{"role": "user", "text": "hi"}, {"role": "dog", "text": "woof"}]
    )
    assert "Robert" in prompt
    assert "Ada" in prompt
    assert "hi" in prompt and "woof" in prompt


def test_system_prompt_truncates_history_to_last_10():
    agent = _agent(RecordingRegistry())
    history = [{"role": "user", "text": f"m{i}"} for i in range(15)]
    prompt = agent._build_system_prompt(None, history)
    assert "m14" in prompt
    assert "m4" not in prompt   # only the last 10 kept (m5..m14)


# --- tool gating by physical/virtual mode ---
def test_enabled_tool_names_virtual_drops_motion_keeps_emote():
    names = _agent(RecordingRegistry())._enabled_tool_names(
        dict(DEFAULT_FLAGS), physical=False)
    assert "send_emote" in names
    assert "run_motion" not in names and "stop" not in names


def test_enabled_tool_names_physical_offers_motion():
    names = _agent(RecordingRegistry())._enabled_tool_names(
        dict(DEFAULT_FLAGS), physical=True)
    assert "run_motion" in names and "stop" in names


# --- get_status is a physical-only truth tool (Task-4 review follow-up) ---
# A virtual/unbound session must NOT see another robot's live status, so
# get_status is withheld unless the session physically holds the robot. The
# legacy no-session path is physical=True and keeps get_status.
def test_enabled_tool_names_virtual_drops_get_status():
    names = _agent(RecordingRegistry())._enabled_tool_names(
        dict(DEFAULT_FLAGS), physical=False)
    assert "get_status" not in names


def test_enabled_tool_names_physical_offers_get_status():
    names = _agent(RecordingRegistry())._enabled_tool_names(
        dict(DEFAULT_FLAGS), physical=True)
    assert "get_status" in names


# --- chat() session awareness (Bedrock faked) ---------------------------
class _FakeAgent:
    """Stand-in for strands.Agent: records what it was built with and, when
    called, invokes the send_emote tool (so publish/no-publish is observable)."""

    last = None

    def __init__(self, model=None, system_prompt=None, tools=None):
        self.system_prompt = system_prompt
        self.tools = list(tools or [])
        self.tool_names = [t.tool_name for t in self.tools]
        type(self).last = self

    def __call__(self, message):
        self.message = message
        for t in self.tools:
            if t.tool_name == "send_emote":
                t("happy")
        return "woof woof"


def _fake_bedrock(monkeypatch):
    monkeypatch.setattr(dog_agent, "Agent", _FakeAgent)
    monkeypatch.setattr(dog_agent, "BedrockModel", lambda **kw: None)


def test_chat_virtual_session_injects_history_persists_no_publish(ddb, monkeypatch):
    _fake_bedrock(monkeypatch)
    sid = sessions.create_session("Ada", True)
    sessions.append_message(sid, "user", "hello there")
    sessions.append_message(sid, "dog", "woof")
    reg = RecordingRegistry()

    out = _agent(reg).chat("sit boy", session_id=sid)

    # user name + prior history injected into the system prompt
    assert "Ada" in _FakeAgent.last.system_prompt
    assert "hello there" in _FakeAgent.last.system_prompt
    # no robot bound -> virtual: emote captured, nothing published, motion absent
    assert out["emote"] == "happy"
    assert reg.sent == []
    assert "run_motion" not in _FakeAgent.last.tool_names
    # session echoed + this turn persisted (user then assistant)
    assert out["session_id"] == sid
    msgs = sessions.get_messages(sid)
    assert msgs[-2]["role"] == "user" and msgs[-2]["text"] == "sit boy"
    assert msgs[-1]["role"] == "dog" and msgs[-1]["text"] == "woof woof"


def test_chat_physical_session_publishes_and_offers_motion(ddb, monkeypatch):
    _fake_bedrock(monkeypatch)
    sid = sessions.create_session("Bob", True)
    sessions.acquire_robot_lock("turtlebot468", sid)
    sessions._update_session(sid, robot_id="turtlebot468")
    assert sessions.robot_for_session(sid) == "turtlebot468"
    reg = RecordingRegistry()

    out = _agent(reg).chat("hi", session_id=sid)

    assert reg.sent == [("turtlebot468", "emote", "happy")]  # published (physical)
    assert "run_motion" in _FakeAgent.last.tool_names
    assert out["emote"] == "happy"
    assert out["session_id"] == sid


# =====================================================================
# Task 4.2: guide_to_room tool (virtual-fleet-only) + fleet-command routing
# =====================================================================


class FleetRegistry:
    """Registry stand-in for the fleet-command path: records fleet commands,
    returns a scripted ack list. send_command is never expected to be hit by
    guide_to_room (it has no robot target at all), but is defined so this
    class stays usable anywhere ScriptedRegistry/RecordingRegistry are."""

    def __init__(self, acks=None):
        self._acks = acks if acks is not None else []
        self.fleet_sent = []
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        self.sent.append((robot_id, cmd))
        return []

    def send_fleet_command(self, cmd, timeout_s=5.0, collect_all=False):
        self.fleet_sent.append(cmd)
        return list(self._acks)

    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "unknown"}


def test_guide_impl_requires_a_session():
    reg = FleetRegistry()
    result = _agent(reg)._guide_impl("Kitchen", None, _captured())
    assert "session" in result.lower()
    assert reg.fleet_sent == []


def test_guide_impl_builds_assign_command_and_binds_visitor(ddb):
    sid = sessions.create_session("Ada", True)
    acks = [
        Ack(cmd_id="c", state="received", simulated=True),
        Ack(cmd_id="c", state="done", simulated=True, assigned_robot_id="virtual/3"),
    ]
    reg = FleetRegistry(acks=acks)

    result = _agent(reg)._guide_impl("Classroom 1425", sid, _captured())

    assert len(reg.fleet_sent) == 1
    cmd = reg.fleet_sent[0]
    assert cmd.type == "assign"
    assert cmd.name == "assign"
    assert cmd.params["room"] == "Classroom 1425"
    visitor_id = cmd.params["visitor_id"]
    assert visitor_id
    assert sessions.visitor_for_session(sid) == visitor_id
    assert "virtual/3" in result


def test_guide_impl_reuses_existing_visitor_binding(ddb):
    sid = sessions.create_session("Ada", True)
    sessions.bind_visitor(sid, "visitor-existing")
    reg = FleetRegistry(acks=[Ack(cmd_id="c", state="done", simulated=True,
                                  assigned_robot_id="virtual/1")])

    _agent(reg)._guide_impl("Kitchen", sid, _captured())

    assert len(reg.fleet_sent) == 1
    assert reg.fleet_sent[0].params["visitor_id"] == "visitor-existing"


# --- from_room: WHERE THE VISITOR IS (optional on the wire) -------------------
# The world spawns the visitor at from_room and sends the robot to them first, so a
# from_room that is present-but-wrong is worse than absent: absent means "entrance",
# the documented pre-existing behaviour. These pin both halves of that contract.


def test_guide_impl_publishes_from_room_when_supplied(ddb):
    sid = sessions.create_session("Ada", True)
    reg = FleetRegistry(acks=[Ack(cmd_id="c", state="done", simulated=True,
                                  assigned_robot_id="virtual/2")])

    _agent(reg)._guide_impl("Kitchen", sid, _captured(), "Classroom 1425")

    params = reg.fleet_sent[0].params
    assert params["room"] == "Kitchen"
    assert params["from_room"] == "Classroom 1425"


def test_guide_impl_omits_from_room_when_not_supplied(ddb):
    """Absent, not empty-string: "" is a valid string against the wire schema, so it
    would reach the world as an unresolvable room name instead of meaning "unknown"."""
    sid = sessions.create_session("Ada", True)
    reg = FleetRegistry(acks=[Ack(cmd_id="c", state="done", simulated=True,
                                  assigned_robot_id="virtual/2")])
    agent = _agent(reg)

    agent._guide_impl("Kitchen", sid, _captured())            # arg omitted entirely
    agent._guide_impl("Kitchen", sid, _captured(), "")        # tool-schema default
    agent._guide_impl("Kitchen", sid, _captured(), "   ")     # whitespace-only answer

    for cmd in reg.fleet_sent:
        assert "from_room" not in cmd.params


def test_guide_impl_from_room_unresolved_tells_the_model_to_re_ask(ddb):
    """The world resolved nothing and dispatched nobody. The model must hear a
    re-ask instruction, not something it can paraphrase as "your guide is coming"."""
    sid = sessions.create_session("Ada", True)
    reg = FleetRegistry(acks=[Ack(cmd_id="c", state="failed", simulated=True,
                                  reason="from_room_unresolved")])

    result = _agent(reg)._guide_impl("Kitchen", sid, _captured(), "the blue sofa")

    lowered = result.lower()
    assert "failed" in lowered
    assert "ask the visitor again" in lowered
    assert "do not tell them a guide is coming" in lowered
    # and it must not read like a success anywhere in the string
    assert "heading over" not in lowered and "on its way" not in lowered


def test_describe_acks_surfaces_from_room_unresolved_as_a_re_ask():
    """Same wording via the shared ack-summary path, so no caller can turn this
    failure into the vague "the robot refused: from_room_unresolved" fallback."""
    acks = [Ack(cmd_id="c", state="failed", simulated=True, reason="from_room_unresolved")]
    assert DogAgent._describe_acks(acks) == dog_agent._FROM_ROOM_UNRESOLVED


def test_guide_impl_target_unresolved_tells_the_model_to_re_ask(ddb):
    sid = sessions.create_session("Ada", True)
    reg = FleetRegistry(acks=[Ack(cmd_id="c", state="failed", simulated=True,
                                  reason="target_unresolved")])
    result = _agent(reg)._guide_impl("Narnia", sid, _captured(), "Kitchen")
    assert "failed" in result.lower()
    assert "guide_to_room again" in result


def test_guide_tool_spec_exposes_from_room():
    """The model can only pass from_room if it is in the tool's input schema."""
    tools = _agent(FleetRegistry())._build_tools(
        ["guide_to_room"], None, _captured(), physical=False, session_id="s")
    schema = tools[0].tool_spec["inputSchema"]["json"]
    assert "from_room" in schema["properties"]
    assert schema["properties"]["from_room"]["type"] == "string"
    assert "room" in schema["required"]


# --- room vocabulary comes from the floor plan, not a hardcoded list ----------


def test_virtual_prompt_asks_where_the_visitor_is_and_lists_real_rooms():
    prompt = _agent(FleetRegistry())._system_prompt(dict(DEFAULT_FLAGS), physical=False)
    lowered = prompt.lower()
    assert "from_room" in prompt
    # instructs the model to ASK, and to reuse an already-stated location
    assert "which room or area they are in" in lowered
    assert "do not ask again" in lowered
    # vocabulary really came from the floor plan file (name + alias)
    assert "Classroom 1425" in prompt
    assert "Gender Neutral Washroom" in prompt
    assert "quiet study" in prompt          # an alias, not just the name


def test_room_vocabulary_matches_the_floor_plan_file():
    """Sourced from the data, so renaming a room in the JSON moves the prompt with
    it. Compared against the file itself rather than a copied-out list."""
    import json
    from pathlib import Path

    dog_agent._floor_plan_rooms.cache_clear()
    repo_root = Path(dog_agent.__file__).resolve().parents[2]
    plan = json.loads(
        (repo_root / "world" / "data" / "floor-14.json").read_text(encoding="utf-8"))
    expected = [r["name"] for r in plan["rooms"]]
    line = dog_agent._room_vocabulary_line()
    assert expected                                   # guard: the fixture file has rooms
    for name in expected:
        assert name in line


def test_room_vocabulary_degrades_to_empty_when_floor_plan_missing(monkeypatch, tmp_path):
    """Prod containers ship no world/ dir, so an unreadable floor plan must cost the
    prompt its room list and nothing else -- never an exception on a visitor's turn."""
    monkeypatch.setenv(dog_agent._FLOOR_PLAN_ENV, str(tmp_path / "nope.json"))
    monkeypatch.setattr(dog_agent, "_FLOOR_PLAN_CANDIDATES", (("no", "such", "file"),))
    dog_agent._floor_plan_rooms.cache_clear()
    try:
        assert dog_agent._floor_plan_rooms() == ()
        assert dog_agent._room_vocabulary_line() == ""
        prompt = _agent(FleetRegistry())._system_prompt(dict(DEFAULT_FLAGS), physical=False)
        assert "guide_to_room" in prompt              # the tool is still advertised
    finally:
        dog_agent._floor_plan_rooms.cache_clear()     # don't poison other tests


def test_guide_impl_no_idle_robot(ddb):
    sid = sessions.create_session("Ada", True)
    reg = FleetRegistry(acks=[Ack(cmd_id="c", state="failed", reason="no_idle_robot",
                                  simulated=True)])
    result = _agent(reg)._guide_impl("Kitchen", sid, _captured())
    assert "busy" in result.lower()


def test_guide_impl_offline_when_no_acks(ddb):
    sid = sessions.create_session("Ada", True)
    reg = FleetRegistry(acks=[])
    result = _agent(reg)._guide_impl("Kitchen", sid, _captured())
    assert result == dog_agent._OFFLINE


# --- tool gating: guide_to_room is virtual-only (inverse of run_motion/stop) ---
def test_enabled_tool_names_virtual_offers_guide_to_room():
    names = _agent(RecordingRegistry())._enabled_tool_names(
        dict(DEFAULT_FLAGS), physical=False)
    assert "guide_to_room" in names


def test_enabled_tool_names_physical_withholds_guide_to_room():
    names = _agent(RecordingRegistry())._enabled_tool_names(
        dict(DEFAULT_FLAGS), physical=True)
    assert "guide_to_room" not in names


def test_system_prompt_mentions_guide_only_when_virtual():
    agent = _agent(RecordingRegistry())
    virtual_prompt = agent._system_prompt(dict(DEFAULT_FLAGS), physical=False)
    physical_prompt = agent._system_prompt(dict(DEFAULT_FLAGS), physical=True)
    assert "guide_to_room" in virtual_prompt
    assert "guide_to_room" not in physical_prompt


# =====================================================================
# Capability-aware system prompt: the model must be told WHICH robot it is
# driving. The physical TurtleBot does emotes/tricks/stop and has no navigation
# at all; the virtual fleet robot navigates to rooms and does no physical
# motion. The prompt must never advertise the other fleet's abilities.
# =====================================================================


# Every tool name DogAgent can offer. Used by the prompt/tools agreement guard
# below: a tool named in the prompt must be a tool the model actually got.
_ALL_TOOL_NAMES = ("send_emote", "run_motion", "stop", "get_status",
                   "retrieve_kb", "guide_to_room")


def test_virtual_prompt_omits_physical_motion_vocabulary():
    """Regression guard for the real bug: MOTION_INSTRUCTION was appended on the
    motion_tools_enabled flag alone, so a VIRTUAL session was told it had
    run_motion/stop/get_status while _enabled_tool_names withheld all three."""
    prompt = _agent(RecordingRegistry())._system_prompt(
        dict(DEFAULT_FLAGS), physical=False)
    assert "run_motion" not in prompt
    assert "trick" not in prompt.lower()
    assert "get_status" not in prompt


def test_physical_prompt_mentions_emote_and_tricks_not_guide():
    prompt = _agent(RecordingRegistry())._system_prompt(
        dict(DEFAULT_FLAGS), physical=True)
    assert "send_emote" in prompt
    assert "trick" in prompt.lower()
    assert "guide_to_room" not in prompt


def test_physical_prompt_states_it_cannot_navigate_to_rooms():
    prompt = _agent(RecordingRegistry())._system_prompt(
        dict(DEFAULT_FLAGS), physical=True)
    lowered = prompt.lower()
    assert "cannot navigate" in lowered
    assert "cannot drive" in lowered


def test_virtual_prompt_states_it_can_navigate_to_rooms():
    prompt = _agent(RecordingRegistry())._system_prompt(
        dict(DEFAULT_FLAGS), physical=False)
    lowered = prompt.lower()
    assert "can navigate to any room" in lowered
    assert "escort" in lowered


def test_virtual_prompt_calls_emote_an_avatar_expression():
    """A virtual session has no robot to emote on (ws_chat's target is None), so
    the prompt must not claim a robot performs it."""
    prompt = _agent(RecordingRegistry())._system_prompt(
        dict(DEFAULT_FLAGS), physical=False)
    assert "avatar" in prompt.lower()


def _tool_names_in(prompt):
    import re
    return {n for n in _ALL_TOOL_NAMES if re.search(rf"\b{n}\b", prompt)}


def test_prompt_never_names_a_tool_the_model_was_not_given():
    """The single regression guard for the bug class: for BOTH modes, every tool
    name the prompt mentions must be in that mode's offered tool list."""
    agent = _agent(RecordingRegistry())
    for physical in (True, False):
        flags = dict(DEFAULT_FLAGS)
        prompt = agent._system_prompt(flags, physical=physical)
        offered = set(agent._enabled_tool_names(flags, physical=physical))
        mentioned = _tool_names_in(prompt)
        assert mentioned <= offered, (
            f"physical={physical}: prompt names {sorted(mentioned - offered)} "
            f"but offered tools are {sorted(offered)}"
        )


def test_chat_legacy_no_session_id_unchanged(monkeypatch):
    _fake_bedrock(monkeypatch)
    reg = RecordingRegistry()

    out = _agent(reg).chat("hello")

    assert "session_id" not in out                 # legacy return shape preserved
    assert out["emote"] == "happy"
    # legacy default is physical against the first configured robot
    assert reg.sent == [("turtlebot468", "emote", "happy")]
