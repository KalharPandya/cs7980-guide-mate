import json
import logging

from guidemate_msgs.jsonlog import log_extra, setup


def test_setup_emits_json_with_correlation_ids(capsys):
    log = setup("unittest")
    log.info("hello", extra=log_extra(turn_id="t1", cmd_id="c1", session_id=None))
    line = capsys.readouterr().out.strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["component"] == "unittest"
    assert payload["level"] == "INFO"
    assert payload["msg"] == "hello"
    assert payload["turn_id"] == "t1"
    assert payload["cmd_id"] == "c1"
    assert "session_id" not in payload  # None dropped by log_extra
    assert payload["ts"].endswith("+00:00")


def test_setup_is_idempotent_single_handler():
    setup("a")
    setup("b")
    assert len(logging.getLogger().handlers) == 1
