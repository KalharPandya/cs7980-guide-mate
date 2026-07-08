"""Playwright e2e for the admin panel (gated `GUIDEMATE_E2E=1`).

Boots a real uvicorn subprocess with GUIDEMATE_FAKE_ROBOT=1 (no MQTT / no robot)
and a random admin password, then drives Chromium headless through the admin UI.

DynamoDB is REAL (`guidemate-config`): every test that mutates a flag or the
prompt restores the prior value in a `finally` block so the table is left as it
was found. Bedrock is never exercised (no chat). The kill switch is verified by
stubbing the `/api/admin/kill-switch` response in the browser (page.route) so the
full confirm -> POST -> success-alert wiring is exercised WITHOUT ever writing the
real robot's IoT shadow (admin.py builds a real boto3 iot-data client; fakes.py
does not stub it, so we never let that request leave the browser).

Selectors are taken from the real merged DOM (static/admin/index.html +
static/admin/admin.js), not the brief's guesses.
"""
import contextlib
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

pytestmark = pytest.mark.e2e

# Random per-run password (never a fixed literal in the repo).
PASSWORD = "e2e-" + secrets.token_urlsafe(16)
THING = "Turtlebot-468"  # matches Config default GUIDEMATE_THING_NAMES for turtlebot468


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
    env.setdefault("AWS_REGION", "us-west-2")
    # agent_service is on sys.path via --app-dir; import string is the package path.
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
def _api(page, path, method="GET", body=None):
    """Call an admin API endpoint from inside the page (carries the cookie)."""
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


@contextlib.contextmanager
def _page(server_url, headless=True):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        try:
            page = browser.new_page()
            page.goto(server_url + "/admin/")
            yield page
        finally:
            browser.close()


def _login(page):
    page.fill("#password", PASSWORD)
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#panel:not([hidden])", timeout=5000)


# --- login ---------------------------------------------------------------
def test_admin_wrong_password(server_url):
    with _page(server_url) as page:
        page.fill("#password", "definitely-wrong")
        page.click("#login-form button[type=submit]")
        page.wait_for_selector("#login-error", timeout=5000)
        # The JS sets textContent to "Wrong password." on a 401.
        page.wait_for_function(
            "document.getElementById('login-error').textContent.includes('Wrong password')",
            timeout=5000,
        )
        # Panel stays hidden.
        assert page.get_attribute("#panel", "hidden") is not None


def test_admin_login_shows_tabs(server_url):
    with _page(server_url) as page:
        _login(page)
        for tab in ("flags", "prompt", "robot", "knowledge"):
            assert page.is_visible(f'.tabs button[data-tab="{tab}"]')
        # Flags tab renders its checkbox list.
        page.wait_for_selector("#flags-list label")


# --- flag toggle (restores prior value) ----------------------------------
def test_admin_toggle_flag(server_url):
    with _page(server_url) as page:
        _login(page)
        page.wait_for_selector("#flags-list label")
        before = _api(page, "/flags")["body"]["dog_muted"]
        try:
            # Find the dog_muted checkbox by its label text and click it.
            target = None
            for label in page.query_selector_all("#flags-list label"):
                if "dog_muted" in label.inner_text():
                    target = label.query_selector("input")
                    break
            assert target is not None, "dog_muted checkbox not found"
            target.click()
            # Verify the change round-tripped to DynamoDB via the API.
            page.wait_for_function(
                """(before) => fetch('/api/admin/flags', {credentials:'same-origin'})
                       .then(r => r.json()).then(f => f.dog_muted !== before)""",
                arg=before,
                timeout=5000,
            )
            after = _api(page, "/flags")["body"]["dog_muted"]
            assert after != before
        finally:
            # Restore the prior value regardless of assertion outcome.
            _api(page, "/flags", method="PUT",
                 body={"name": "dog_muted", "value": before})
            restored = _api(page, "/flags")["body"]["dog_muted"]
            assert restored == before


# --- prompt set + clear (restores prior value) ---------------------------
def test_admin_set_and_clear_prompt(server_url):
    with _page(server_url) as page:
        _login(page)
        page.click('.tabs button[data-tab="prompt"]')
        page.wait_for_selector("#tab-prompt:not([hidden])")
        original = _api(page, "/prompt")["body"]["system_prompt"]
        marker = "You are a stern robot. Be brief."
        try:
            page.fill("#prompt-text", marker)
            page.click("#prompt-save")
            page.wait_for_function(
                """(m) => fetch('/api/admin/prompt', {credentials:'same-origin'})
                       .then(r => r.json()).then(d => d.system_prompt === m)""",
                arg=marker,
                timeout=5000,
            )
            assert _api(page, "/prompt")["body"]["system_prompt"] == marker

            # Clear it via the UI -> stored prompt becomes null (built-in persona).
            page.click("#prompt-clear")
            page.wait_for_function(
                """() => fetch('/api/admin/prompt', {credentials:'same-origin'})
                       .then(r => r.json()).then(d => d.system_prompt === null)""",
                timeout=5000,
            )
            assert _api(page, "/prompt")["body"]["system_prompt"] is None
        finally:
            # Restore whatever prompt was there before this test ran.
            _api(page, "/prompt", method="PUT", body={"system_prompt": original})
            assert _api(page, "/prompt")["body"]["system_prompt"] == original


# --- robot tab renders the fake robot's status incl. gates ---------------
def test_admin_robot_tab_renders_status(server_url):
    with _page(server_url) as page:
        _login(page)
        page.click('.tabs button[data-tab="robot"]')
        page.wait_for_selector("#robot-list .robot")
        text = page.inner_text("#robot-list")
        assert "turtlebot468" in text
        # Fake registry reports online + docked + the safety gates.
        assert "online" in text
        # gates rendered as "motion_enabled=false, dry_run=true"
        assert "motion_enabled" in text and "dry_run" in text
        # The kill-switch button exists on the card.
        assert page.is_visible("#robot-list .robot button.danger")


# --- kill switch: confirm -> POST -> 200 path (stubbed, never hits AWS) ---
def test_admin_kill_switch_confirm_fires(server_url):
    with _page(server_url) as page:
        _login(page)
        page.click('.tabs button[data-tab="robot"]')
        page.wait_for_selector("#robot-list .robot")

        # Intercept the kill-switch POST so we exercise the UI wiring end-to-end
        # (confirm -> fetch -> success alert) WITHOUT writing the real IoT shadow.
        captured = {"called": False, "post_body": None}

        def _route(route):
            req = route.request
            captured["called"] = True
            captured["post_body"] = req.post_data
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"ok": true, "thing": "%s", "desired": {"dry_run": true, "motion_enabled": false}}' % THING,
            )

        page.route("**/api/admin/kill-switch", _route)

        dialogs = []

        def _on_dialog(d):
            dialogs.append(d.message)
            d.accept()  # accept the confirm() AND the success alert()

        page.on("dialog", _on_dialog)

        page.click("#robot-list .robot button.danger")
        # Wait for both dialogs (confirm + success alert) to have fired.
        deadline = time.time() + 5
        while time.time() < deadline and len(dialogs) < 2:
            page.wait_for_timeout(100)

        assert captured["called"], "kill-switch POST was never sent"
        assert "robot_id" in (captured["post_body"] or "")
        assert "turtlebot468" in (captured["post_body"] or "")
        # First dialog is the confirm, second is the success alert.
        assert any("Kill switch" in m for m in dialogs)
        assert any("Kill switch sent" in m for m in dialogs)


# --- kill switch: cancel the confirm -> nothing fires --------------------
def test_admin_kill_switch_cancel_does_not_fire(server_url):
    with _page(server_url) as page:
        _login(page)
        page.click('.tabs button[data-tab="robot"]')
        page.wait_for_selector("#robot-list .robot")

        captured = {"called": False}

        def _route(route):
            captured["called"] = True
            route.fulfill(status=200, content_type="application/json", body='{"ok": true}')

        page.route("**/api/admin/kill-switch", _route)

        def _on_dialog(d):
            d.dismiss()  # cancel the confirm()

        page.on("dialog", _on_dialog)

        page.click("#robot-list .robot button.danger")
        page.wait_for_timeout(500)
        assert captured["called"] is False, "kill-switch fired despite cancelled confirm"
