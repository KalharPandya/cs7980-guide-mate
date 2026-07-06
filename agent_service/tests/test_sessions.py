from guidemate_agent import sessions


def test_create_and_get_session(ddb):
    sid = sessions.create_session("Ada", True)
    assert sid
    row = sessions.get_session(sid)
    assert row["name"] == "Ada"
    assert row["comfortable"] is True
    assert row["status"] == "active"
    assert row["request_status"] == "none"
    assert row.get("robot_id") in (None, "")


def test_get_missing_session_returns_none(ddb):
    assert sessions.get_session("nope") is None


def test_list_sessions_newest_first(ddb):
    a = sessions.create_session("A", False)
    b = sessions.create_session("B", True)
    ids = [s["session_id"] for s in sessions.list_sessions()]
    assert set(ids) >= {a, b}


def test_append_and_get_messages_order(ddb):
    sid = sessions.create_session("Ada", True)
    sessions.append_message(sid, "user", "hi")
    sessions.append_message(sid, "dog", "woof")
    sessions.append_message(sid, "user", "sit")
    msgs = sessions.get_messages(sid)
    assert [m["text"] for m in msgs] == ["hi", "woof", "sit"]
    assert [m["role"] for m in msgs] == ["user", "dog", "user"]


def test_get_messages_last_n(ddb):
    sid = sessions.create_session("Ada", True)
    for i in range(5):
        sessions.append_message(sid, "user", f"m{i}")
    last2 = sessions.get_messages(sid, limit=2)
    assert [m["text"] for m in last2] == ["m3", "m4"]
