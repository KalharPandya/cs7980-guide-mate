from guidemate_agent import sessions


def test_create_request_captures_intake(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    req = sessions.get_request(rid)
    assert req["session_id"] == sid
    assert req["name"] == "Ada"
    assert req["comfortable"] is True
    assert req["status"] == "pending"
    assert sessions.get_session(sid)["request_status"] == "pending"


def test_list_pending_requests(ddb):
    s1 = sessions.create_session("A", True)
    s2 = sessions.create_session("B", False)
    r1 = sessions.create_request(s1)
    r2 = sessions.create_request(s2)
    ids = [r["request_id"] for r in sessions.list_pending_requests()]
    assert set(ids) == {r1, r2}


def test_acquire_lock_is_exclusive(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)
    assert sessions.acquire_robot_lock("turtlebot468", a) is True
    assert sessions.acquire_robot_lock("turtlebot468", b) is False
    assert sessions.get_lock_holder("turtlebot468") == a


def test_release_then_reacquire(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)
    assert sessions.acquire_robot_lock("turtlebot468", a) is True
    sessions.release_robot_lock("turtlebot468")
    assert sessions.get_lock_holder("turtlebot468") is None
    assert sessions.acquire_robot_lock("turtlebot468", b) is True


def test_robot_for_session_requires_binding_and_lock(ddb):
    a = sessions.create_session("A", True)
    # No lock yet -> not physical.
    assert sessions.robot_for_session(a) is None
    sessions.acquire_robot_lock("turtlebot468", a)
    sessions._update_session(a, robot_id="turtlebot468", request_status="approved")
    assert sessions.robot_for_session(a) == "turtlebot468"
    # Lock stolen by another session -> a is no longer authoritative.
    sessions.release_robot_lock("turtlebot468")
    b = sessions.create_session("B", True)
    sessions.acquire_robot_lock("turtlebot468", b)
    assert sessions.robot_for_session(a) is None
