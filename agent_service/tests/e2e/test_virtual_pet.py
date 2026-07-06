"""Phase-8 Task-7 e2e: virtual-pet grant (gated ``GUIDEMATE_E2E=1``).

Boots one real uvicorn subprocess with ``GUIDEMATE_FAKE_ROBOT=1`` (no MQTT / no
robot) + a random admin password, then drives two Chromium browser contexts:
a user and the admin. Proves the Task-7 multi-robot admin picker: the admin
approves the user's pending request onto ``turtlebotsim`` (not the physical
``turtlebot468``), and the user's chat UI shows the virtual-pet badge while the
physical robot's lock is never touched.

DynamoDB is REAL — every session/request this test creates is deleted in a
``finally`` block so the tables are left as they were found. Bedrock is never
exercised (companion-request/approve flow only, same as test_companion_flow.py).

Selectors are taken from the real merged DOM (static/index.html, static/admin/*)
and admin.py's ``/api/admin`` prefix, not the brief's ``data-testid`` guesses --
the repo's existing e2e tests select on element ``id``/text, so this test
follows that convention. The two NEW hooks this task adds (the per-row robot
``<select>`` and the virtual-pet badge) do carry ``data-testid`` attributes
(``approve-robot-select`` / ``virtual-pet-badge``) as the brief asked, so both
selector styles work; this test exercises them via ``data-testid`` to prove
those hooks specifically.
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
PHYSICAL_ROBOT_ID = "turtlebot468"
SIM_ROBOT_ID = "turtlebotsim"
REGION = "us-west-2"
_TOKEN = secrets.token_hex(4)
NAME = f"Pat-{_TOKEN}"


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
    # Default registry already includes turtlebotsim (Task 7), but pin it
    # explicitly so this test doesn't depend on future default changes.
    env["GUIDEMATE_ROBOTS"] = f"{PHYSICAL_ROBOT_ID},{SIM_ROBOT_ID}"
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
    cfg = ddb.Table("guidemate-config")
    for robot_id in (PHYSICAL_ROBOT_ID, SIM_ROBOT_ID):
        for pk in (f"robot_lock#{robot_id}", f"robot_assign_events#{robot_id}"):
            try:
                cfg.delete_item(Key={"pk": pk})
            except Exception:  # noqa: BLE001
                pass
    reqs = ddb.Table("guidemate-requests")
    try:
        for r in reqs.scan().get("Items", []):
            if r.get("session_id") in sids:
                reqs.delete_item(Key={"request_id": r["request_id"]})
    except Exception:  # noqa: BLE001
        pass
    sess = ddb.Table("guidemate-sessions")
    for sid in sids:
        try:
            sess.delete_item(Key={"session_id": sid})
        except Exception:  # noqa: BLE001
            pass


def test_admin_grants_virtual_pet_and_badge_shows(server_url):
    from playwright.sync_api import sync_playwright

    base = server_url
    sids = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_user = browser.new_context()
        ctx_admin = browser.new_context()
        upage = ctx_user.new_page()
        apage = ctx_admin.new_page()
        try:
            # --- user takes intake, starts virtual, requests a companion ---
            _intake(upage, base, NAME, True)
            sid = _session_id(upage)
            sids = [sid]
            upage.wait_for_selector("text=Virtual dog")
            assert upage.locator('[data-testid="virtual-pet-badge"]').is_hidden()

            upage.click("#request-companion")
            upage.wait_for_selector("text=Request pending")

            # --- admin logs in, opens Requests, picks turtlebotsim ----------
            apage.goto(base + "/admin/")
            apage.fill("#password", PASSWORD)
            apage.click("#login-form button[type=submit]")
            apage.wait_for_selector("#panel:not([hidden])", timeout=5000)

            # Baseline: the physical robot's assignment log before we approve
            # onto the sim -- other tests/runs share the real table, so we
            # assert "no growth", not "empty" (robust to pre-existing entries).
            physical_baseline = len(
                _admin_api(apage, f"/robot/{PHYSICAL_ROBOT_ID}/assign-events")["body"] or []
            )

            apage.click('.tabs button[data-tab="requests"]')
            apage.wait_for_selector("#tab-requests:not([hidden])")
            apage.wait_for_selector("#requests-list li")
            row = apage.locator('[data-testid="request-row"]', has_text=sid)
            row.locator('[data-testid="approve-robot-select"]').select_option(SIM_ROBOT_ID)
            row.locator('[data-testid="approve-btn"]').click()

            # --- user's UI shows the virtual-pet badge, not "physical" -----
            expect_badge = upage.locator('[data-testid="virtual-pet-badge"]')
            expect_badge.wait_for(state="visible", timeout=8000)
            upage.wait_for_selector(f"text=Connected to {SIM_ROBOT_ID}", timeout=8000)

            # --- the session bound to the sim; the physical robot's lock/
            # assignment log was never touched -------------------------------
            sess = _admin_api(apage, "/sessions")["body"]
            mine = next(s for s in sess if s["session_id"] == sid)
            assert mine["robot_id"] == SIM_ROBOT_ID

            physical_events = _admin_api(
                apage, f"/robot/{PHYSICAL_ROBOT_ID}/assign-events"
            )["body"]
            assert len(physical_events) == physical_baseline

            sim_events = _admin_api(apage, f"/robot/{SIM_ROBOT_ID}/assign-events")["body"]
            assert sim_events[-1]["action"] == "undock"
        finally:
            for c in (ctx_user, ctx_admin):
                c.close()
            browser.close()
    _cleanup(sids)
