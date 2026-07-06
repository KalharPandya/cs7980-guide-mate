"""Ship the guide-mate bridge journal to CloudWatch Logs from the Pi.

Design: the Pi already has AWS creds (role guidemate-agent-role via
credential_process) and the `aws` CLI, but installing the heavy ARM CloudWatch
agent is not worth it on the compute-tight Pi. Instead a 5-minute systemd timer
runs this: journalctl --cursor-file gives only the NEW lines since last run,
which we push with `aws logs put-log-events` (no sequence token needed on modern
CloudWatch), plus one PiHeartbeat EMF event so the bridge-offline alarm has data.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from typing import Iterator

LOG_GROUP = "/guidemate/bridge"
CURSOR_FILE = "/var/lib/guidemate/logship.cursor"
AWS_BIN = os.environ.get("AWS_BIN", "aws")
REGION = os.environ.get("AWS_REGION", "us-west-2")


def parse_journal_json(text: str) -> list[dict]:
    """journalctl -o json lines -> [{'timestamp': ms, 'message': str}, ...]."""
    events: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("MESSAGE")
        ts_us = rec.get("__REALTIME_TIMESTAMP")
        if msg is None or ts_us is None:
            continue
        if isinstance(msg, list):  # journald renders non-UTF8 fields as byte arrays
            msg = bytes(msg).decode("utf-8", "replace")
        events.append({"timestamp": int(ts_us) // 1000, "message": str(msg)})
    return events


def chunk_events(events: list[dict], max_n: int = 1000) -> Iterator[list[dict]]:
    for i in range(0, len(events), max_n):
        yield events[i : i + max_n]


def heartbeat_event(robot_id: str, now_ms: int) -> dict:
    emf = {
        "_aws": {
            "Timestamp": now_ms,
            "CloudWatchMetrics": [
                {
                    "Namespace": "GuideMate",
                    "Dimensions": [["robot_id"]],
                    "Metrics": [{"Name": "PiHeartbeat", "Unit": "Count"}],
                }
            ],
        },
        "robot_id": robot_id,
        "PiHeartbeat": 1,
    }
    return {"timestamp": now_ms, "message": json.dumps(emf)}


def _aws(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [AWS_BIN, "--region", REGION, *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _ensure_stream(stream: str) -> None:
    _aws("logs", "create-log-group", "--log-group-name", LOG_GROUP)  # ok if exists
    _aws("logs", "create-log-stream", "--log-group-name", LOG_GROUP, "--log-stream-name", stream)


def _put(stream: str, events: list[dict]) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(events, fh)
        path = fh.name
    try:
        res = _aws(
            "logs", "put-log-events",
            "--log-group-name", LOG_GROUP,
            "--log-stream-name", stream,
            "--log-events", f"file://{path}",
        )
        if res.returncode != 0:
            sys.stderr.write(res.stderr)
    finally:
        os.unlink(path)


def main() -> None:
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
    stream = robot_id
    os.makedirs(os.path.dirname(CURSOR_FILE), exist_ok=True)
    proc = subprocess.run(
        [
            "journalctl", "-u", "guidemate-bridge", "-o", "json",
            "--no-pager", f"--cursor-file={CURSOR_FILE}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    events = parse_journal_json(proc.stdout)
    events.append(heartbeat_event(robot_id, int(time.time() * 1000)))
    events.sort(key=lambda e: e["timestamp"])
    _ensure_stream(stream)
    for batch in chunk_events(events):
        _put(stream, batch)


if __name__ == "__main__":
    main()
