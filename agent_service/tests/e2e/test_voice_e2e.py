"""Playwright fake-mic e2e for the full voice path (gated ``GUIDEMATE_E2E=1``).

Follows the same real-uvicorn-subprocess pattern as test_admin_maps.py /
test_companion_flow.py (no shared conftest fixtures exist in this repo's e2e
suite -- ``server_url`` is each module's own fixture). ``GUIDEMATE_FAKE_ROBOT=1``
avoids MQTT/robot dependencies (same as the other e2e tests); the chat turn
itself still makes REAL calls to Bedrock (DogAgent), Amazon Transcribe (STT)
and Polly (TTS) -- there is no way to drive `/ws/chat` end to end without
them, so this test needs real AWS creds in addition to a display + Chrome.

Chrome's fake-mic is fed a WAV built from Polly PCM (`synthesize_pcm16` +
`pcm16_to_wav`) via ``--use-fake-device-for-media-stream`` +
``--use-file-for-fake-audio-capture=<wav>``: clicking #mic starts a real
getUserMedia() capture that Chrome backs with the WAV file's samples instead
of a real microphone, so the AudioWorklet pipeline in chat.js runs unmodified.

Adaptation vs the brief: `/` IS gated by the Phase-4 intake form (`#name` +
`#start`), confirmed by reading static/index.html + chat.js -- `_reach_chat`
fills the intake and clicks Start rather than just waiting for `#chat-form`.
The brief's TODO seam is resolved here, not deferred.

Sync assertion: chat.js only adds the `.emote-<name>` class to `#avatar`
inside the `<audio id="player">` `play` event handler (`armPendingEmote` just
records the pending emote when the "reply" frame arrives). So right after the
reply bubble appears -- before the "audio" frame/blob exists -- the avatar
must NOT yet carry an emote class; only once the player's `src` is set (the
"audio" frame landed and playback was kicked off) may the emote class appear.
This test asserts both halves of that ordering, not just that the class
eventually shows up.
"""
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

from guidemate_agent.speech import pcm16_to_wav, synthesize_pcm16

pytestmark = pytest.mark.e2e

PASSWORD = "e2e-" + secrets.token_urlsafe(16)
NAME = "Voicey-" + secrets.token_hex(3)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _make_fake_mic_wav() -> str:
    """Polly 'do a happy wiggle' -> 16k PCM -> WAV file for Chrome's fake audio capture."""
    pcm = synthesize_pcm16("do a happy wiggle", sample_rate=16000)
    wav = pcm16_to_wav(pcm, sample_rate=16000)
    path = os.path.join(tempfile.mkdtemp(), "fake-mic.wav")
    with open(path, "wb") as f:
        f.write(wav)
    return path


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


def _reach_chat(page, base):
    """Phase-4 intake gates '/': fill name + submit before the chat surface appears."""
    page.goto(base + "/")
    page.fill("#name", NAME)
    page.click("#start")
    page.wait_for_selector("#chat:not([hidden])", timeout=10000)
    page.wait_for_selector("#chat-form", timeout=10000)


def test_voice_in_transcript_reply_emote_audio(server_url):
    from playwright.sync_api import sync_playwright

    wav = _make_fake_mic_wav()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                f"--use-file-for-fake-audio-capture={wav}",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        try:
            ctx = browser.new_context(permissions=["microphone"])
            page = ctx.new_page()
            _reach_chat(page, server_url)

            page.click("#mic")            # start recording -> streams the fake-mic wav
            page.wait_for_timeout(3500)   # let the ~2s "do a happy wiggle" clip play through
            page.click("#mic")            # stop -> triggers stop_audio -> transcript + reply

            # Transcript bubble carries the spoken word "wiggle" (real Transcribe result).
            page.wait_for_selector("text=wiggle", timeout=20000)

            # A dog reply bubble appears (real Bedrock + emote tool call). The emote
            # itself is metadata now — NOT printed in the bubble — it is asserted
            # below via the avatar animation class (the emote<->audio sync check).
            page.wait_for_selector(".bubble.dog", timeout=20000)

            # Sync half 1: right after the reply bubble lands, the avatar must NOT yet
            # carry an emote class -- chat.js only applies it on the <audio> 'play' event,
            # not on arrival of the reply frame.
            pre_audio_emote = page.evaluate(
                "() => ['happy', 'yes', 'no'].some("
                "  e => document.getElementById('avatar').classList.contains('emote-' + e))"
            )
            assert pre_audio_emote is False, (
                "avatar carried an emote class before the audio frame arrived -- "
                "emote fired too early, not synced to playback"
            )

            # Audio element received a source (Polly reply, real synthesize_mp3 call).
            page.wait_for_function(
                "document.getElementById('player').src.length > 0", timeout=20000
            )

            # Sync half 2: once the audio element has a source (the "audio" frame
            # landed and playback was kicked off), the emote class must show up.
            page.wait_for_function(
                "() => ['happy', 'yes', 'no'].some("
                "  e => document.getElementById('avatar').classList.contains('emote-' + e))",
                timeout=20000,
            )
        finally:
            browser.close()
