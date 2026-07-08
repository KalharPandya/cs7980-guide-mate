import pytest

from guidemate_agent.prodcheck import assert_chat_roundtrip


def test_roundtrip_ok():
    assert_chat_roundtrip(
        {"emote": "happy", "robot": [{"state": "done", "simulated": True}]}
    )  # no raise


def test_roundtrip_missing_emote_raises():
    with pytest.raises(AssertionError, match="emote"):
        assert_chat_roundtrip({"emote": None, "robot": [{"simulated": True}]})


def test_roundtrip_no_simulated_ack_raises():
    with pytest.raises(AssertionError, match="simulated"):
        assert_chat_roundtrip({"emote": "happy", "robot": [{"state": "done"}]})
