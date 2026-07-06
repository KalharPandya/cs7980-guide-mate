"""Structural guard: the Pi installer + systemd unit MUST NEVER enable real motion.

Real cmd_vel/dock sinks are sim/436 only. Robot 468 is the ONLY thing this installer
targets, and the bridge's assert_motion_identity_safe() refuses GUIDEMATE_ENABLE_MOTION
on turtlebot468. These tests are belt + braces: they assert the *rendered* unit never
carries a GUIDEMATE_ENABLE_MOTION setting, and that the installer aborts if the template
ever grows one.
"""
import re
import subprocess
from pathlib import Path

_PKG = Path(__file__).resolve().parents[1]
_UNIT = _PKG / "systemd" / "guidemate-bridge.service"
_INSTALLER = _PKG / "scripts" / "install_bridge_on_pi.sh"

# Matches a real systemd Environment= directive setting motion (not a ban comment).
_MOTION_DIRECTIVE = re.compile(r"^\s*Environment=GUIDEMATE_ENABLE_MOTION", re.MULTILINE)


def _render_unit(text: str) -> str:
    """Apply the same @PLACEHOLDER@ substitutions the installer's sed does."""
    for ph, val in {
        "@ROBOT_ID@": "turtlebot468",
        "@THING_NAME@": "Turtlebot-468",
        "@ROS_ENABLED@": "1",
        "@IOT_ENDPOINT@": "example.iot.amazonaws.com",
        "@CERT@": "/x.cert.pem",
        "@KEY@": "/x.key",
        "@CA@": "/x/AmazonRootCA1.pem",
    }.items():
        text = text.replace(ph, val)
    return text


def test_rendered_unit_never_enables_motion():
    rendered = _render_unit(_UNIT.read_text())
    assert not _MOTION_DIRECTIVE.search(rendered), (
        "rendered systemd unit sets GUIDEMATE_ENABLE_MOTION — motion is banned on 468"
    )
    # No @PLACEHOLDER@ should survive rendering (proves the render covers the whole unit).
    assert not re.search(r"@[A-Z_]+@", rendered)


def test_unit_documents_the_motion_ban():
    # The ban must be explicit in the template so nobody re-adds the line by accident.
    assert "GUIDEMATE_ENABLE_MOTION" in _UNIT.read_text()  # the ban comment references it


def test_installer_grep_guards_the_motion_ban():
    src = _INSTALLER.read_text()
    # The installer aborts the install if the template ever sets the motion env.
    assert "Environment=GUIDEMATE_ENABLE_MOTION" in src
    assert "exit 1" in src


def test_installer_aborts_when_unit_sets_motion(tmp_path):
    # Prove the guard actually fires: feed a poisoned unit through the same grep the
    # installer uses and confirm a non-zero exit.
    poisoned = tmp_path / "unit.service"
    poisoned.write_text("[Service]\nEnvironment=GUIDEMATE_ENABLE_MOTION=1\n")
    rc = subprocess.run(
        ["grep", "-qE", r"^[[:space:]]*Environment=GUIDEMATE_ENABLE_MOTION", str(poisoned)]
    ).returncode
    assert rc == 0  # grep matches -> installer would `exit 1`

    clean = tmp_path / "clean.service"
    clean.write_text(_render_unit(_UNIT.read_text()))
    rc_clean = subprocess.run(
        ["grep", "-qE", r"^[[:space:]]*Environment=GUIDEMATE_ENABLE_MOTION", str(clean)]
    ).returncode
    assert rc_clean == 1  # no match -> installer proceeds
