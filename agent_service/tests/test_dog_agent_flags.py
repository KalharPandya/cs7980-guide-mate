"""Unit tests for per-turn flag gating + persona/mute in DogAgent.

Fake store + fake registry only — no Bedrock, no DynamoDB, no network. These
verify that flags read fresh each turn steer the tool list and system prompt,
and that dog_muted short-circuits before any Bedrock model is built.
"""

from guidemate_agent.dog_agent import (
    DogAgent,
    EMOTE_INSTRUCTION,
    NEUTRAL_PROMPT,
    PERSONA_BASE,
)
from guidemate_agent.store import DEFAULT_FLAGS


class FakeRegistry:
    def send_command(self, robot_id, cmd, timeout_s=5.0):
        return []


class FakeStore:
    def __init__(self, flags=None, prompt=None):
        self._flags = dict(DEFAULT_FLAGS)
        if flags:
            self._flags.update(flags)
        self._prompt = prompt

    def get_flags(self):
        return dict(self._flags)

    def get_prompt(self):
        return self._prompt


def _agent(flags=None, prompt=None):
    return DogAgent(
        registry=FakeRegistry(),
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
        store=FakeStore(flags, prompt),
    )


# --- tool-name gating -----------------------------------------------------
def test_all_permissive_flags_offer_emote_and_kb():
    names = _agent()._enabled_tool_names(dict(DEFAULT_FLAGS))
    assert "send_emote" in names
    assert "retrieve_kb" in names


def test_emotes_disabled_removes_send_emote():
    names = _agent()._enabled_tool_names({**DEFAULT_FLAGS, "emotes_enabled": False})
    assert "send_emote" not in names


def test_kb_disabled_removes_retrieve_kb():
    names = _agent()._enabled_tool_names({**DEFAULT_FLAGS, "kb_enabled": False})
    assert "retrieve_kb" not in names


def test_motion_tools_offered_when_enabled():
    # ADAPTED: motion tools (run_motion/stop) landed in the Phase-2 cloud lane,
    # so they ARE offered when motion_tools_enabled is True (the brief's
    # "_motion_available is False, absent until integrated" test is obsolete).
    names = _agent()._enabled_tool_names(dict(DEFAULT_FLAGS))
    assert "run_motion" in names
    assert "stop" in names


def test_motion_disabled_removes_motion_tools():
    names = _agent()._enabled_tool_names(
        {**DEFAULT_FLAGS, "motion_tools_enabled": False}
    )
    assert "run_motion" not in names
    assert "stop" not in names


# --- system prompt --------------------------------------------------------
def test_system_prompt_uses_persona_and_emote_rule_by_default():
    prompt = _agent()._system_prompt(dict(DEFAULT_FLAGS))
    assert PERSONA_BASE in prompt
    assert EMOTE_INSTRUCTION in prompt


def test_system_prompt_neutral_when_persona_disabled():
    prompt = _agent()._system_prompt({**DEFAULT_FLAGS, "persona_enabled": False})
    assert NEUTRAL_PROMPT in prompt
    assert "Robert" not in prompt


def test_system_prompt_omits_emote_rule_when_emotes_disabled():
    prompt = _agent()._system_prompt({**DEFAULT_FLAGS, "emotes_enabled": False})
    assert EMOTE_INSTRUCTION not in prompt


def test_admin_prompt_replaces_persona_base():
    prompt = _agent(prompt="You are a stern robot. Be brief.")._system_prompt(
        dict(DEFAULT_FLAGS)
    )
    assert "stern robot" in prompt
    assert PERSONA_BASE not in prompt
    # emote instruction is still appended programmatically
    assert EMOTE_INSTRUCTION in prompt


# --- mute -----------------------------------------------------------------
def test_muted_returns_sleeping_without_bedrock():
    # No BedrockModel is constructed on the mute path, so this runs with no
    # creds/network.
    result = _agent({"dog_muted": True}).chat("hello")
    assert result == {
        "reply_text": "(the dog is sleeping)",
        "emote": None,
        "robot": [],
        "turn_id": result["turn_id"],
    }
    assert result["turn_id"]
