"""Real IoT Core round-trip: bridge subprocess <-> AWS IoT Core <-> RobotRegistry.

Gated by the `integration` marker (conftest skips it unless GUIDEMATE_INTEGRATION=1).
Runs the real bridge as a subprocess on this box with the dev cert, robot_id=devtest,
dry-run, and asserts a full received->running->done, simulated=True round-trip over the
real IoT Core data plane in under 10 s.

Note on ordering: the bridge publishes received/running/done sub-millisecond apart, and
AWS IoT QoS1 does NOT guarantee delivery order across separate publishes. RobotRegistry
.send_command returns as soon as the terminal `done` ack arrives, so its returned list
can legitimately miss an ack the broker reordered after `done` (observed live:
received @ +3044 ms, done @ +3051 ms, running @ +3098 ms). We therefore capture the full
status stream and assert on the complete set, which proves the real round-trip without
depending on an ordering guarantee IoT Core does not make.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

import pytest

from guidemate_msgs.messages import Command

from guidemate_agent.mqtt_link import RobotRegistry

DEV_CERT = os.path.expanduser("~/.aws/guidemate-dev.cert.pem")
DEV_KEY = os.path.expanduser("~/.aws/guidemate-dev.private.key")
CA_PATH = os.path.expanduser("~/certs/AmazonRootCA1.pem")
CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem"


def _discover_endpoint() -> str:
    out = subprocess.check_output(
        ["aws", "iot", "describe-endpoint", "--endpoint-type", "iot:Data-ATS",
         "--query", "endpointAddress", "--output", "text"],
        text=True,
    )
    return out.strip()


def _ensure_ca() -> str:
    if not os.path.exists(CA_PATH):
        os.makedirs(os.path.dirname(CA_PATH), exist_ok=True)
        urllib.request.urlretrieve(CA_URL, CA_PATH)
    return CA_PATH


@pytest.mark.integration
def test_real_iot_roundtrip():
    endpoint = _discover_endpoint()
    ca = _ensure_ca()
    env = dict(os.environ)
    env.update({
        "GUIDEMATE_ROBOT_ID": "devtest",
        "GUIDEMATE_IOT_ENDPOINT": endpoint,
        "GUIDEMATE_CERT": DEV_CERT,
        "GUIDEMATE_KEY": DEV_KEY,
        "GUIDEMATE_CA": ca,
        "GUIDEMATE_DRY_RUN": "1",
    })
    bridge = subprocess.Popen(
        [sys.executable, "-m", "guide_mate_bridge.bridge"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    reg = RobotRegistry(endpoint=endpoint, region="us-west-2", robot_ids=["devtest"])

    # Capture every ack for our cmd_id off the same connection RobotRegistry uses,
    # independent of send_command's terminate-on-done behaviour (see module docstring).
    seen: list[tuple[str, str, bool]] = []  # (cmd_id, state, simulated)
    seen_lock = threading.Lock()
    real_on_status = reg._on_status

    def _collect(topic, payload, dup, qos, retain, **kwargs):
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            data = {}
        cmd_id = data.get("cmd_id")
        if cmd_id:
            with seen_lock:
                seen.append((cmd_id, data.get("state"), bool(data.get("simulated"))))
        return real_on_status(topic, payload, dup, qos, retain, **kwargs)

    reg._on_status = _collect  # patched before connect() so the subscription uses it

    try:
        reg.connect()
        time.sleep(3.0)  # let the bridge connect + subscribe
        cmd = Command(type="emote", name="happy")
        start = time.time()
        acks = reg.send_command("devtest", cmd, timeout_s=10.0)
        # send_command returns on the terminal `done`; briefly drain for any ack the
        # broker reordered after it, capped so total round-trip stays under 10 s.
        deadline = start + 10.0
        while time.time() < deadline:
            with seen_lock:
                have = {st for cid, st, _ in seen if cid == cmd.cmd_id}
            if {"received", "running", "done"} <= have:
                break
            time.sleep(0.05)
        elapsed = time.time() - start

        with seen_lock:
            mine = [(st, sim) for cid, st, sim in seen if cid == cmd.cmd_id]
        states = {st for st, _ in mine}

        # The full round-trip crossed real IoT Core: all three lifecycle acks arrived.
        assert {"received", "running", "done"} <= states, f"missing acks; got {mine}"
        # The terminal done ack reports dry-run simulation.
        assert ("done", True) in mine, f"done not simulated; got {mine}"
        # And it happened well within budget.
        assert elapsed < 10.0, f"round-trip took {elapsed:.2f}s"
        # send_command's own return value still carries the terminal done ack.
        assert any(a.state == "done" and a.simulated for a in acks), \
            f"send_command missing simulated done; got {[a.state for a in acks]}"
    finally:
        bridge.terminate()
        try:
            bridge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge.kill()
