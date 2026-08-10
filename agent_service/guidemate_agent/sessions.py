"""DynamoDB session layer: sessions, per-session messages, companion requests,
and the atomic per-robot lock. Self-contained (no dependency on store.py).

Key schemas match the deployed Phase 3 tables (scripts/create_dynamo_tables.py,
verified via describe-table): guidemate-messages uses ``ts`` as its RANGE key and
guidemate-config uses ``pk`` as its partition key. (The Phase 4 brief drafted
these as ``sk``/``key``; corrected here so put_item/query work against the real
tables — DynamoDB rejects an item missing the table's range-key attribute.)
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from guidemate_msgs.messages import Command

from guidemate_agent.robot_lifecycle import assign_actions, end_actions

REGION = "us-west-2"
TABLE_SESSIONS = "guidemate-sessions"
TABLE_MESSAGES = "guidemate-messages"
TABLE_REQUESTS = "guidemate-requests"
TABLE_CONFIG = "guidemate-config"
# Partition-key ATTRIBUTE NAME of guidemate-config (Phase 3
# create_dynamo_tables.py; confirmed via describe-table). store.py keys the
# same table on "pk".
CONFIG_PK = "pk"
# Sort-key ATTRIBUTE NAME of guidemate-messages (Phase 3; confirmed via
# describe-table). The stored value keeps the "{iso_ts}#{uuid}" form so it is
# unique and sorts chronologically.
MESSAGE_SK = "ts"

_resource = None


def _ddb():
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb", region_name=REGION)
    return _resource


def _table(name: str):
    return _ddb().Table(name)


def new_id() -> str:
    return uuid.uuid4().hex


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- sessions ----
def create_session(name: str, comfortable: bool) -> str:
    session_id = new_id()
    _table(TABLE_SESSIONS).put_item(
        Item={
            "session_id": session_id,
            "name": name,
            "comfortable": bool(comfortable),
            "created_ts": _now_iso(),
            "status": "active",
            "request_status": "none",
            "robot_id": None,
            "visitor_id": None,
        }
    )
    return session_id


def ensure_session(session_id: str, name: str) -> None:
    """Idempotently ensure a session row exists at this EXACT session_id.

    Unlike create_session (which always mints a fresh uuid), this is used by
    the autonomy EventEngine to keep a stable, well-known system session (e.g.
    "system-autonomy") visible in the admin Sessions tab without duplicating
    the row on every fired rule. No-op if the row already exists.
    """
    try:
        _table(TABLE_SESSIONS).put_item(
            Item={
                "session_id": session_id,
                "name": name,
                "comfortable": False,
                "created_ts": _now_iso(),
                "status": "active",
                "request_status": "none",
                "robot_id": None,
                "visitor_id": None,
            },
            ConditionExpression="attribute_not_exists(session_id)",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise


def get_session(session_id: str) -> Optional[dict]:
    item = _table(TABLE_SESSIONS).get_item(Key={"session_id": session_id}).get("Item")
    return item


def list_sessions() -> list[dict]:
    rows = _table(TABLE_SESSIONS).scan().get("Items", [])
    return sorted(rows, key=lambda r: r.get("created_ts", ""), reverse=True)


# ---------------------------------------------------------------- messages ----
def append_message(session_id: str, role: str, text: str) -> str:
    sk = f"{_now_iso()}#{new_id()}"
    _table(TABLE_MESSAGES).put_item(
        Item={"session_id": session_id, MESSAGE_SK: sk, "role": role, "text": text}
    )
    return sk


def get_messages(session_id: str, limit: Optional[int] = None) -> list[dict]:
    items = _table(TABLE_MESSAGES).query(
        KeyConditionExpression=Key("session_id").eq(session_id),
        ScanIndexForward=True,
    ).get("Items", [])
    if limit is not None:
        return items[-limit:]
    return items


# ---------------------------------------------------------------- requests ----
def _update_session(session_id: str, **attrs) -> None:
    names = {f"#a{i}": k for i, k in enumerate(attrs)}
    values = {f":v{i}": v for i, v in enumerate(attrs.values())}
    set_expr = ", ".join(f"#a{i} = :v{i}" for i in range(len(attrs)))
    _table(TABLE_SESSIONS).update_item(
        Key={"session_id": session_id},
        UpdateExpression="SET " + set_expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def create_request(
    session_id: str,
    kind: str = "companion",
    from_room: Optional[str] = None,
    to_room: Optional[str] = None,
) -> str:
    """Create a pending request row for an operator to approve.

    `kind` distinguishes the two approval paths: "companion" (the default, a
    physical-robot lock) and "guide" (a virtual-fleet escort). `from_room` and
    `to_room` carry a guide request's origin/destination and are stored only
    when supplied, so existing companion callers keep their exact row shape.
    The dedup-on-pending guard is unchanged: a session already pending reuses
    its open request rather than stacking a second one.
    """
    session = get_session(session_id) or {}
    if session.get("request_status") == "pending":
        existing = [
            r for r in list_pending_requests() if r.get("session_id") == session_id
        ]
        if existing:
            return existing[0]["request_id"]
    request_id = new_id()
    item = {
        "request_id": request_id,
        "session_id": session_id,
        "name": session.get("name", ""),
        "comfortable": bool(session.get("comfortable", False)),
        "status": "pending",
        "created_ts": _now_iso(),
        "kind": kind,
    }
    if from_room is not None:
        item["from_room"] = from_room
    if to_room is not None:
        item["to_room"] = to_room
    _table(TABLE_REQUESTS).put_item(Item=item)
    if kind == "guide":
        # Clear any stale guide fields from a PRIOR, already-approved guide so a
        # superseded guide's awareness (guide_robot_id/from_room/to_room) cannot
        # leak into this new request. Without this, get_guide_status would keep
        # returning the old from_room and dog_agent's awareness line would feed the
        # model a wrong "current location" for the visitor. Only for kind=="guide":
        # a companion request must never touch these virtual-fleet fields.
        _update_session(
            session_id,
            request_status="pending",
            guide_robot_id=None,
            guide_from_room=None,
            guide_to_room=None,
        )
    else:
        _update_session(session_id, request_status="pending")
    return request_id


def get_request(request_id: str) -> Optional[dict]:
    return _table(TABLE_REQUESTS).get_item(Key={"request_id": request_id}).get("Item")


def list_pending_requests() -> list[dict]:
    rows = _table(TABLE_REQUESTS).scan().get("Items", [])
    pending = [r for r in rows if r.get("status") == "pending"]
    return sorted(pending, key=lambda r: r.get("created_ts", ""))


def _set_request_status(request_id: str, status: str) -> None:
    _table(TABLE_REQUESTS).update_item(
        Key={"request_id": request_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": status},
    )


# ------------------------------------------------------------- robot lock ----
def _lock_key(robot_id: str) -> dict:
    return {CONFIG_PK: f"robot_lock#{robot_id}"}


def acquire_robot_lock(robot_id: str, session_id: str) -> bool:
    try:
        item = dict(_lock_key(robot_id))
        item.update({"session_id": session_id, "acquired_ts": _now_iso()})
        _table(TABLE_CONFIG).put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(#k)",
            ExpressionAttributeNames={"#k": CONFIG_PK},
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def get_lock_holder(robot_id: str) -> Optional[str]:
    item = _table(TABLE_CONFIG).get_item(Key=_lock_key(robot_id)).get("Item")
    return item.get("session_id") if item else None


def release_robot_lock(robot_id: str) -> None:
    _table(TABLE_CONFIG).delete_item(Key=_lock_key(robot_id))


def robot_for_session(session_id: str) -> Optional[str]:
    session = get_session(session_id)
    if not session:
        return None
    robot_id = session.get("robot_id")
    if not robot_id:
        return None
    if get_lock_holder(robot_id) == session_id:
        return robot_id
    return None


# ------------------------------------------------------------- visitor id ----
# Task 4.2: the virtual-fleet counterpart of the robot_id/robot-lock binding above, but
# deliberately much simpler -- the virtual fleet has no scarcity to arbitrate (up to
# ~50 robots, no physical safety risk), so a visitor_id needs neither an approval
# workflow nor a per-robot lock table, just a plain attribute on the session row.
def bind_visitor(session_id: str, visitor_id: str) -> None:
    _update_session(session_id, visitor_id=visitor_id)


def visitor_for_session(session_id: str) -> Optional[str]:
    session = get_session(session_id)
    if not session:
        return None
    return session.get("visitor_id") or None


def keepalive_visitor(session_id: str, registry=None) -> bool:
    """Keep this session's virtual visitor alive in the 3D world while the chat is active.

    The world auto-despawns a delivered REAL visitor after an inactivity window
    (world/src/rooms/escortManager.ts's REAL_VISITOR_DESPAWN_S). Without a
    keepalive that window is a fixed post-delivery timer, so a real chat user
    guided to a room had her avatar removed while she was still talking. Called
    on EVERY chat turn (both the HTTP and WS paths -- the single shared point
    both go through), this publishes a fleet keepalive that re-arms that window
    in the world, so the avatar survives as long as the session keeps talking
    and is only cleaned up once the turns stop.

    Publishes ONLY when the session has a bound visitor_id: a session with no
    bound virtual visitor (a physical/companion session, or a guided session
    before its first assign) publishes nothing. Reuses the SAME fleet-command
    path approve_guide_request uses -- a `stop` command carrying
    `params.scope == "keepalive"` (mirrors the clear-real-visitors scope; keeps
    the wire schema unchanged, params is free-form). Best-effort: any lookup or
    publish failure is swallowed so a keepalive can NEVER break the chat turn.
    Returns True iff a keepalive was actually published.
    """
    if registry is None:
        return False
    try:
        visitor_id = visitor_for_session(session_id)
        if not visitor_id:
            return False
        cmd = Command(
            type="stop",
            name="stop",
            params={"scope": "keepalive", "visitor_id": visitor_id},
        )
        registry.send_fleet_command(cmd)
        return True
    except Exception:  # noqa: BLE001 — keepalive is best-effort, never breaks a turn
        return False


# ------------------------------------------------------------ orchestration ----
ASSIGN_EVENTS_KEEP = 10


def get_session_state(session_id: str) -> dict:
    session = get_session(session_id) or {}
    return {
        "request_status": session.get("request_status", "none"),
        "robot_id": robot_for_session(session_id),
        # Task 4.3: additive field -- None until the session's first guide_to_room
        # tool call binds a virtual-fleet visitor_id (dog_agent._guide_impl ->
        # sessions.bind_visitor). The existing 3s /api/session/{id}/state poll
        # (chat.js renderState) already carries request_status/robot_id for the
        # companion banner; visitor_id rides the same poll rather than adding a
        # new endpoint or a WS message-shape change.
        "visitor_id": session.get("visitor_id") or None,
    }


def _mark_session_aborted(session_id: str) -> None:
    _update_session(session_id, request_status="aborted", robot_id=None)


# ---- assignment-triggered undock/dock (spec delta, commit 91d9bcb) ----
# Phase 4 only SENDS these and records the outcome; bridge-side execution
# (Create 3 dock actions + dock-guard exemption) is Phase 8. On robot 468 the
# expected outcome is a refusal ack — that is evidence, not an error.
def _record_assign_event(robot_id: str, action: str, acks: list) -> dict:
    event = {
        "action": action,                       # "undock" | "dock"
        "ts": _now_iso(),
        "acks": [a.model_dump() for a in acks],
        "refused": bool(acks) and acks[-1].state == "failed",
    }
    key = {CONFIG_PK: f"robot_assign_events#{robot_id}"}
    # NOTE: read-modify-write with no conditional guard — safe only under the
    # POC's single-service-instance assumption; concurrent writers would lose
    # events (last-write-wins on the whole list).
    item = _table(TABLE_CONFIG).get_item(Key=key).get("Item")
    events = json.loads(item["events_json"]) if item else []
    events.append(event)
    events = events[-ASSIGN_EVENTS_KEEP:]
    # Stored as a JSON string: sidesteps DynamoDB's float restriction on ack
    # fields (e.g. battery) and keeps the item a single small attribute.
    new_item = dict(key)
    new_item["events_json"] = json.dumps(events)
    _table(TABLE_CONFIG).put_item(Item=new_item)
    return event


def get_assign_events(robot_id: str) -> list[dict]:
    key = {CONFIG_PK: f"robot_assign_events#{robot_id}"}
    item = _table(TABLE_CONFIG).get_item(Key=key).get("Item")
    return json.loads(item["events_json"]) if item else []


# Create 3 dock/undock actions take 10-60 s; the registry returns as soon as a
# terminal ack lands, so a fast completion still returns fast.
ACTION_TIMEOUT_S = 75.0


def _make_send(registry):
    """Adapt a registry to robot_lifecycle's send(robot_id, cmd, timeout_s) -> [Ack].
    Best-effort: a missing registry or a send failure yields no acks (never raises)."""

    def send(robot_id: str, cmd: Command, timeout_s: float):
        if registry is None:
            return []
        try:
            return registry.send_command(robot_id, cmd, timeout_s=timeout_s)
        except Exception:  # noqa: BLE001 — best-effort by design
            return []

    return send


def _live_docked(registry, robot_id: str):
    """Robot's live dock state (True/False), or None when unknown/unavailable."""
    if registry is None:
        return None
    try:
        return registry.get_status(robot_id).get("docked")
    except Exception:  # noqa: BLE001 — unknown dock state, let the bridge gate it
        return None


def _run_lifecycle(registry, robot_id: str, actions, **kwargs) -> None:
    """Run a lifecycle action list (see robot_lifecycle) and record each outcome."""
    send = _make_send(registry)
    for action, acks in actions(send, robot_id, ACTION_TIMEOUT_S, **kwargs):
        _record_assign_event(robot_id, action, acks)


def _bind_robot(robot_id: str, session_id: str, registry=None) -> Optional[str]:
    aborted = None
    holder = get_lock_holder(robot_id)
    if holder and holder != session_id:
        release_robot_lock(robot_id)
        _mark_session_aborted(holder)
        _run_lifecycle(registry, robot_id, end_actions)          # unassign -> dock
        aborted = holder
    if not acquire_robot_lock(robot_id, session_id):
        # Lost a race (or same session re-binding): reset and take it.
        # NOTE: this unconditional release+retake bypasses the conditional
        # put's atomicity — under MULTI-instance concurrency a loser could
        # stomp a winner's fresh lock. Safe only for the POC's single
        # service instance (robot_for_session still prevents double-drive:
        # it requires binding AND current lock-holder to match).
        release_robot_lock(robot_id)
        acquire_robot_lock(robot_id, session_id)
    _update_session(
        session_id, robot_id=robot_id, request_status="approved",
        last_active_ts=_now_iso(),
    )
    # assign -> undock, then a bounded forward nudge iff the undock succeeds.
    # Already-undocked robot = pure handover (no undock attempt, no nudge).
    _run_lifecycle(registry, robot_id, assign_actions,
                   docked=_live_docked(registry, robot_id))
    return aborted


def approve_request(request_id: str, robot_id: str, registry=None) -> dict:
    req = get_request(request_id)
    if not req:
        raise KeyError(f"no such request {request_id}")
    aborted = _bind_robot(robot_id, req["session_id"], registry=registry)
    _set_request_status(request_id, "approved")
    return {"session_id": req["session_id"], "aborted_session_id": aborted}


def approve_guide_request(request_id: str, registry=None) -> dict:
    """Operator-approve a VIRTUAL guide request: fire the named fleet "assign"
    that spawns the visitor and dispatches a guide robot, then record which robot
    was assigned on the session so Moses can tell the visitor about it later.

    This is the virtual counterpart of approve_request (which binds a PHYSICAL
    robot lock). The assign that dog_agent used to publish inline at tool-call
    time now happens HERE, at approval time -- the visitor id is minted/reused
    here (the virtual fleet has no scarcity to arbitrate, so no lock), and the
    assigned robot id is parsed from the last ack that carries one.
    """
    req = get_request(request_id)
    if not req:
        raise KeyError(f"no such request {request_id}")
    session_id = req["session_id"]
    name = req.get("name")
    from_room = req.get("from_room")
    to_room = req.get("to_room")

    visitor_id = visitor_for_session(session_id)
    if visitor_id is None:
        visitor_id = f"visitor-{uuid.uuid4().hex[:12]}"
        bind_visitor(session_id, visitor_id)

    params = {"visitor_id": visitor_id, "room": to_room}
    if isinstance(from_room, str) and from_room.strip():
        params["from_room"] = from_room
    if isinstance(name, str) and name.strip():
        params["name"] = name
    cmd = Command(type="assign", name="assign", params=params)
    acks = registry.send_fleet_command(cmd) if registry is not None else []
    assigned_robot_id = None
    for a in acks:
        rid = getattr(a, "assigned_robot_id", None)
        if rid:
            assigned_robot_id = rid

    _set_request_status(request_id, "approved")
    _update_session(
        session_id,
        request_status="approved",
        guide_robot_id=assigned_robot_id,
        guide_from_room=from_room,
        guide_to_room=to_room,
    )
    return {
        "session_id": session_id,
        "assigned_robot_id": assigned_robot_id,
        "acks": [a.model_dump() for a in acks],
    }


def get_guide_status(session_id: str) -> dict:
    """The virtual-guide fields recorded on the session by approve_guide_request,
    for Moses's awareness on later turns. None values when no guide was dispatched."""
    session = get_session(session_id) or {}
    return {
        "guide_robot_id": session.get("guide_robot_id") or None,
        "guide_from_room": session.get("guide_from_room") or None,
        "guide_to_room": session.get("guide_to_room") or None,
    }


def deny_request(request_id: str) -> None:
    req = get_request(request_id)
    if not req:
        raise KeyError(f"no such request {request_id}")
    _set_request_status(request_id, "denied")
    _update_session(req["session_id"], request_status="denied")


def abort_robot(robot_id: str, registry=None) -> Optional[str]:
    holder = get_lock_holder(robot_id)
    release_robot_lock(robot_id)
    if holder:
        _mark_session_aborted(holder)
        _run_lifecycle(registry, robot_id, end_actions)          # unassign -> dock
    return holder


def reassign_robot(robot_id: str, session_id: str, registry=None) -> Optional[str]:
    return _bind_robot(robot_id, session_id, registry=registry)


def assign_virtual(session_id: str, registry=None) -> Optional[str]:
    """Put a session into VIRTUAL / navigation mode: release any physical robot
    it holds (docking that robot via end_actions) and clear its binding, so
    robot_for_session -> None and the agent runs in virtual mode on its next
    turn. Returns the freed physical robot id, or None if it held none. The
    session stays ACTIVE (this is a mode switch, not an end/abort)."""
    robot_id = robot_for_session(session_id)
    if robot_id:
        release_robot_lock(robot_id)
        _run_lifecycle(registry, robot_id, end_actions)          # unassign -> dock
    # Clear the binding either way; request_status stays "approved" so the
    # session keeps running (unlike abort_robot/end_session, which mark the
    # holder aborted/ended).
    _update_session(session_id, robot_id=None, request_status="approved")
    return robot_id


# ---- end of assignment (guest end button / idle timeout) -> dock ----
def touch_session(session_id: str) -> None:
    """Stamp last activity so the idle sweeper leaves an active session alone."""
    _update_session(session_id, last_active_ts=_now_iso())


def end_session(session_id: str, registry=None) -> Optional[str]:
    """End an assignment: release the robot lock, mark the session ended, and dock.
    No-op (returns None) if the session holds no robot. Returns the freed robot id."""
    robot_id = robot_for_session(session_id)
    if not robot_id:
        return None
    release_robot_lock(robot_id)
    _update_session(session_id, status="ended", request_status="ended", robot_id=None)
    _run_lifecycle(registry, robot_id, end_actions)              # end -> dock
    return robot_id


def _iso_age_seconds(ts: str, now_iso: str) -> float:
    a = datetime.fromisoformat(ts)
    b = datetime.fromisoformat(now_iso)
    return (b - a).total_seconds()


def sweep_idle_sessions(idle_timeout_s: float, registry=None) -> list[str]:
    """End every robot-holding session idle longer than idle_timeout_s (dock each).
    Returns the ended session ids. Best-effort: never raises for one bad row."""
    now = _now_iso()
    ended: list[str] = []
    for sess in list_sessions():
        sid = sess.get("session_id")
        if not sid or not robot_for_session(sid):
            continue
        last = sess.get("last_active_ts") or sess.get("created_ts")
        if not last:
            continue
        try:
            idle = _iso_age_seconds(str(last), now)
        except ValueError:
            continue
        if idle >= idle_timeout_s and end_session(sid, registry=registry):
            ended.append(sid)
    return ended
