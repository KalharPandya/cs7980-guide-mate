"""Playwright e2e for the admin Maps tab (gated `GUIDEMATE_E2E=1`).

Follows the same real-uvicorn-subprocess pattern as test_admin.py (no shared
conftest fixtures exist in this repo's e2e suite -- `server_url` + the
`_page`/`_login` helpers are each module's own). GUIDEMATE_FAKE_ROBOT=1 avoids
MQTT/robot dependencies; app.state.s3 is still a REAL boto3 client (Task 5's
app.py wiring), so whichever way `get_object` resolves in this environment
(a real map, no credentials, or an unreachable bucket) admin.py's blanket
except -> 404 means the tab always renders one of its two states cleanly:
the image, or the "No map uploaded yet." empty note. Either is acceptable
evidence that the tab renders end-to-end.
"""
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

pytestmark = pytest.mark.e2e

PASSWORD = "e2e-" + secrets.token_urlsafe(16)


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


def _login(page):
    page.fill("#password", PASSWORD)
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#panel:not([hidden])", timeout=5000)


def test_admin_maps_tab_renders(server_url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(server_url + "/admin/")
            _login(page)
            page.click('.tabs button[data-tab="maps"]')
            page.wait_for_selector("#tab-maps:not([hidden])")

            # The refresh instructions are always present (read-only tab).
            page.wait_for_selector("details summary")
            assert "How to refresh this map" in page.inner_text("#tab-maps details summary")

            # Robot picker is populated from /status (at least the default robot).
            page.wait_for_function(
                "document.getElementById('maps-robot').options.length > 0",
                timeout=5000,
            )

            # Either the map image shows (a map was reachable) or the empty-state
            # note does -- both are valid renders of a working tab. Wait for the
            # <img> to actually finish loading (or fail), not just for `hidden` to
            # flip -- `hidden` is set synchronously before the browser has even
            # sent the image request, so is_visible() would race a 0x0 <img>.
            page.wait_for_function(
                """() => {
                    const img = document.getElementById('maps-image');
                    const empty = document.getElementById('maps-empty');
                    if (!empty.hidden) return true;               // empty-state rendered
                    return !img.hidden && img.complete;            // image finished loading
                }""",
                timeout=5000,
            )
            image_visible = page.is_visible("#maps-image") and page.evaluate(
                "document.getElementById('maps-image').naturalWidth > 0"
            )
            empty_visible = page.is_visible("#maps-empty")
            assert image_visible or empty_visible
        finally:
            browser.close()
