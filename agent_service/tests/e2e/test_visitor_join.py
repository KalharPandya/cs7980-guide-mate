"""Task 4.3 exit e2e: phone-join visitor banner (gated ``GUIDEMATE_E2E=1``).

Boots one real uvicorn subprocess with ``GUIDEMATE_FAKE_ROBOT=1`` (no MQTT / no
robot), same pattern as test_companion_flow.py / test_virtual_pet.py / test_
voice_e2e.py. Unlike the companion-flow tests, this one DOES exercise real
Bedrock (DogAgent's guide_to_room tool call has to actually fire), the same
tradeoff test_voice_e2e.py already makes for a real chat turn -- there is no
way to drive the model's tool-choice through the real chat page without it.

DynamoDB is REAL (guidemate-sessions); the session row this test creates is
deleted in a ``finally`` block.

What it proves (the Task 4.3 acceptance criterion): loading the existing `/`
chat page and asking to be guided to a room is itself the join flow -- no
separate join page/endpoint exists or is needed. The visitor's session gets a
visitor_id bound server-side on the first successful guide_to_room call
(dog_agent._guide_impl -> sessions.bind_visitor), and that shows up as a
"you're the visitor on the big screen" banner via the SAME 3-second
/api/session/{id}/state poll that already drives the companion banner (no new
endpoint, no WS message-shape change -- see sessions.get_session_state's new
``visitor_id`` field and chat.js's ``renderState``).
"""
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

import boto3
import pytest

pytestmark = pytest.mark.e2e

REGION = "us-west-2"
_TOKEN = secrets.token_hex(4)
NAME = f"Vera-{_TOKEN}"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def server_url():
    port = _free_port()
    env = dict(os.environ)
    env["GUIDEMATE_FAKE_ROBOT"] = "1"
    env.setdefault("AWS_REGION", REGION)
    # Windows-only belt-and-suspenders: Strands' default callback handler prints
    # streamed tokens to stdout, and Robert's persona emits emoji; Windows stdout
    # defaults to cp1252, which crashes the turn AFTER the model (and the
    # guide_to_room tool call this test depends on) already succeeded. Prod runs
    # on Linux/UTF-8 and never hits this -- see the "dog-agent-local-run-windows"
    # memory note. This env var, not a code change, is the documented workaround.
    env["PYTHONUTF8"] = "1"
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn",
            "guidemate_agent.app:app",
            "--app-dir", "agent_service",
            "--host", "127.0.0.1",
            "--port", str(port),
        ],
        env=env,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"uvicorn exited early with code {proc.returncode}")
            try:
                with urllib.request.urlopen(url + "/healthz", timeout=1) as resp:
                    if resp.status == 200:
                        break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            raise RuntimeError("uvicorn did not become healthy")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def _intake(page, base, name):
    page.goto(base + "/")
    page.fill("#name", name)
    page.click("#start")
    page.wait_for_selector("#chat:not([hidden])")


def _session_id(page):
    return page.evaluate("() => localStorage.getItem('guidemate_session_id')")


def _cleanup(sids):
    ddb = boto3.resource("dynamodb", region_name=REGION)
    sess = ddb.Table("guidemate-sessions")
    for sid in sids:
        try:
            sess.delete_item(Key={"session_id": sid})
        except Exception:  # noqa: BLE001
            pass


def test_chat_message_binds_visitor_and_shows_banner(server_url):
    from playwright.sync_api import sync_playwright

    base = server_url
    sids = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        try:
            _intake(page, base, NAME)
            sid = _session_id(page)
            sids = [sid]
            page.wait_for_selector("text=Virtual dog")

            # Banner starts hidden -- no visitor_id bound yet.
            assert page.locator('[data-testid="visitor-banner"]').is_hidden()

            # "Take me to room X" style message over the real chat WS -- this is
            # the ONLY join step; no separate join page/form exists.
            page.fill("#message", "Can you guide me to the Kitchen?")
            page.click("#chat-form button[type=submit]")

            # A dog reply bubble appears (real Bedrock turn + guide_to_room tool
            # call; GUIDEMATE_FAKE_ROBOT=1's FakeRobotRegistry.send_fleet_command
            # always simulates a successful assign).
            page.wait_for_selector(".bubble.dog .bubble-body", timeout=20000)

            # The visitor-bound banner appears within a couple of the 3s state
            # polls (chat.js renderState -> visitor-banner, driven by the new
            # visitor_id field on GET /api/session/{id}/state).
            page.wait_for_selector(
                '[data-testid="visitor-banner"]:not(.hidden)', timeout=10000
            )
        finally:
            ctx.close()
            browser.close()
    _cleanup(sids)
