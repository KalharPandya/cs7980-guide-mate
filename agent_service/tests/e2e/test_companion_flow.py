"""Phase-4 exit e2e: three-context companion flow (gated ``GUIDEMATE_E2E=1``).

Boots one real uvicorn subprocess with ``GUIDEMATE_FAKE_ROBOT=1`` (no MQTT / no
robot) + a random admin password, then drives THREE Chromium browser contexts
against it: user A, user B, and the admin. DynamoDB is REAL — every session /
request / lock / assign-event this test creates is deleted in a ``finally`` block
so the four guidemate tables are left as they were found.

Bedrock is NEVER exercised. The whole flow is driven through the session/request
endpoints + the request-companion button + the 3-second ``state`` banner poll and
the admin UI — no chat turns (which would need a live model). The chat page's
virtual-emote indicator still ships (avatar + ``#emote-label``); it is simply not
driven here because that path requires Bedrock.

What it proves (Phase 4 exit criteria):
- lock exclusivity: A drives the physical robot while B stays virtual;
- the approve-triggered undock attempt + its motion-locked REFUSAL is recorded and
  rendered on the admin Robot tab (``#assign-event``);
- an admin reassign flips A's banner to "disconnected by admin" within ~6 s (two
  polls) and B's banner to "Connected", and records the dock (A unassign) + undock
  (B assign) pair;
- an admin direct dock command is refused, and the refusal is shown in the UI.

Selectors/routes are taken from the real merged DOM + router (static/index.html,
static/admin/*, admin.py's ``/api/admin`` prefix), not the brief's guesses.
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

PASSWORD = "e2e-" + secrets.token_urlsafe(16)
ROBOT_ID = "turtlebot468"
REGION = "us-west-2"
_TOKEN = secrets.token_hex(4)
NAME_A = f"Ada-{_TOKEN}"
NAME_B = f"Bo-{_TOKEN}"


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
    env["GUIDEMATE_ADMIN_PASSWORD"] = PASSWORD
    env.setdefault("AWS_REGION", REGION)
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


# --- helpers -------------------------------------------------------------
def _intake(page, base, name, comfortable):
    page.goto(base + "/")
    page.fill("#name", name)
    if comfortable:
        page.check("#comfortable")
    page.click("#start")
    page.wait_for_selector("#chat:not([hidden])")


def _session_id(page):
    return page.evaluate("() => localStorage.getItem('guidemate_session_id')")


def _admin_api(page, path, method="GET", body=None):
    """Call an /api/admin endpoint from inside the admin page (carries cookie)."""
    return page.evaluate(
        """async ({p, method, body}) => {
            const opts = { method, credentials: 'same-origin' };
            if (body !== null) {
                opts.headers = { 'Content-Type': 'application/json' };
                opts.body = JSON.stringify(body);
            }
            const r = await fetch('/api/admin' + p, opts);
            let data = null;
            try { data = await r.json(); } catch (e) { data = null; }
            return { ok: r.ok, status: r.status, body: data };
        }""",
        {"p": path, "method": method, "body": body},
    )


def _cleanup(sids):
    """Delete every DynamoDB item this test created (real tables)."""
    ddb = boto3.resource("dynamodb", region_name=REGION)
    # Robot lock + assignment-event log live in guidemate-config keyed on "pk".
    cfg = ddb.Table("guidemate-config")
    for pk in (f"robot_lock#{ROBOT_ID}", f"robot_assign_events#{ROBOT_ID}"):
        try:
            cfg.delete_item(Key={"pk": pk})
        except Exception:  # noqa: BLE001
            pass
    # Requests belonging to our sessions.
    reqs = ddb.Table("guidemate-requests")
    try:
        for r in reqs.scan().get("Items", []):
            if r.get("session_id") in sids:
                reqs.delete_item(Key={"request_id": r["request_id"]})
    except Exception:  # noqa: BLE001
        pass
    # The sessions themselves.
    sess = ddb.Table("guidemate-sessions")
    for sid in sids:
        try:
            sess.delete_item(Key={"session_id": sid})
        except Exception:  # noqa: BLE001
            pass


def test_companion_flow_exclusivity_reassign_and_dock_refusal(server_url):
    from playwright.sync_api import sync_playwright

    base = server_url
    sids = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_a = browser.new_context()
        ctx_b = browser.new_context()
        ctx_admin = browser.new_context()
        page_a = ctx_a.new_page()
        page_b = ctx_b.new_page()
        admin = ctx_admin.new_page()
        try:
            # --- A + B take intake; both start virtual --------------------
            _intake(page_a, base, NAME_A, True)
            _intake(page_b, base, NAME_B, False)
            sid_a, sid_b = _session_id(page_a), _session_id(page_b)
            sids = [sid_a, sid_b]
            page_a.wait_for_selector("text=Virtual dog")
            page_b.wait_for_selector("text=Virtual dog")

            # --- A requests the physical companion ------------------------
            page_a.click("#request-companion")
            page_a.wait_for_selector("text=Request pending")

            # --- Admin logs in via the real UI ----------------------------
            admin.goto(base + "/admin/")
            admin.fill("#password", PASSWORD)
            admin.click("#login-form button[type=submit]")
            admin.wait_for_selector("#panel:not([hidden])", timeout=5000)

            # --- Admin approves A's request via the Requests tab ----------
            admin.click('.tabs button[data-tab="requests"]')
            admin.wait_for_selector("#tab-requests:not([hidden])")
            admin.wait_for_selector("#requests-list li")
            row = admin.locator("#requests-list li", has_text=sid_a)
            row.get_by_role("button", name="Approve").click()

            # A's banner flips to physical within ~6 s (2 polls).
            page_a.wait_for_selector("text=Connected to turtlebot468", timeout=8000)

            # The approve fired an undock; its motion-locked refusal is recorded
            # (spec delta 91d9bcb) and rendered on the Robot tab.
            admin.click('.tabs button[data-tab="robot"]')
            admin.wait_for_selector("#tab-robot:not([hidden])")
            admin.wait_for_function(
                "() => { const el = document.getElementById('assign-event');"
                " return el && el.textContent.includes('undock')"
                " && el.textContent.includes('REFUSED'); }",
                timeout=8000,
            )
            # Cross-check via the API (deterministic).
            events = _admin_api(admin, f"/robot/{ROBOT_ID}/assign-events")["body"]
            assert events[-1]["action"] == "undock"
            assert events[-1]["refused"] is True
            assert "motion_disabled" in events[-1]["acks"][-1]["reason"]

            # --- B stays virtual (lock exclusivity) -----------------------
            page_b.wait_for_selector("text=Virtual dog")

            # --- Admin reassigns the robot to B via the Sessions tab ------
            admin.click('.tabs button[data-tab="sessions"]')
            admin.wait_for_selector("#tab-sessions:not([hidden])")
            admin.wait_for_selector("#sessions-list li")
            b_row = admin.locator("#sessions-list li", has_text=NAME_B)
            b_row.get_by_role("button", name="Give robot").click()

            # A's UI shows the abort within ~6 s; B's flips to physical.
            page_a.wait_for_selector("text=disconnected by admin", timeout=8000)
            page_b.wait_for_selector("text=Connected to turtlebot468", timeout=8000)

            # The reassign fired dock (A unassign) then undock (B assign).
            events = _admin_api(admin, f"/robot/{ROBOT_ID}/assign-events")["body"]
            assert [e["action"] for e in events[-2:]] == ["dock", "undock"]

            # --- Admin direct dock command is refused, shown in the UI ----
            admin.click('.tabs button[data-tab="robot"]')
            admin.wait_for_selector("#tab-robot:not([hidden])")
            admin.click("#robot-dock")
            admin.wait_for_function(
                "() => { const el = document.getElementById('robot-command-result');"
                " return el && el.textContent.includes('REFUSED')"
                " && el.textContent.toLowerCase().includes('motion'); }",
                timeout=8000,
            )
            out = _admin_api(
                admin, f"/robot/{ROBOT_ID}/command",
                method="POST", body={"type": "motion", "name": "dock"},
            )["body"]
            assert out["refused"] is True
            assert "motion" in out["acks"][-1]["reason"].lower()
        finally:
            for c in (ctx_a, ctx_b, ctx_admin):
                c.close()
            browser.close()
    _cleanup(sids)
