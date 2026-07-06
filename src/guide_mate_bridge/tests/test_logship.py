import json

from guide_mate_bridge.logship import (
    chunk_events,
    heartbeat_event,
    parse_journal_json,
)


def test_parse_journal_json_extracts_message_and_ms_timestamp():
    lines = "\n".join(
        [
            json.dumps({"__REALTIME_TIMESTAMP": "1700000000000000", "MESSAGE": "hello"}),
            "not json — skipped",
            json.dumps({"__REALTIME_TIMESTAMP": "1700000001000000", "MESSAGE": "world"}),
            json.dumps({"MESSAGE": "no ts — skipped"}),
        ]
    )
    events = parse_journal_json(lines)
    assert events == [
        {"timestamp": 1700000000000, "message": "hello"},
        {"timestamp": 1700000001000, "message": "world"},
    ]


def test_parse_journal_json_decodes_byte_array_message():
    line = json.dumps({"__REALTIME_TIMESTAMP": "1700000000000000", "MESSAGE": [104, 105]})
    assert parse_journal_json(line) == [{"timestamp": 1700000000000, "message": "hi"}]


def test_chunk_events_batches():
    events = [{"timestamp": i, "message": str(i)} for i in range(2500)]
    batches = list(chunk_events(events, max_n=1000))
    assert [len(b) for b in batches] == [1000, 1000, 500]


def test_heartbeat_event_is_valid_emf():
    ev = heartbeat_event("turtlebot468", 1700000000000)
    assert ev["timestamp"] == 1700000000000
    emf = json.loads(ev["message"])
    assert emf["PiHeartbeat"] == 1
    assert emf["robot_id"] == "turtlebot468"
    meta = emf["_aws"]["CloudWatchMetrics"][0]
    assert meta["Namespace"] == "GuideMate"
    assert meta["Metrics"][0]["Name"] == "PiHeartbeat"
    assert meta["Dimensions"] == [["robot_id"]]
