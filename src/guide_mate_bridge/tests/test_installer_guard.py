"""Belt-and-braces installer guard test (P8-T5).

The Pi installer (install_bridge_on_pi.sh) must never itself write
GUIDEMATE_ENABLE_MOTION=1/true anywhere outside a comment. The rendered-systemd-unit
path is already covered exhaustively by test_install_motion_ban.py (P8-T4); this is the
simpler, brief-mandated smoke check directly against the installer script's own text.
"""
import os

HERE = os.path.dirname(__file__)
INSTALLER = os.path.abspath(os.path.join(HERE, "..", "scripts", "install_bridge_on_pi.sh"))


def test_installer_never_enables_motion():
    text = open(INSTALLER).read()
    # The Pi installer must NEVER write GUIDEMATE_ENABLE_MOTION into the systemd unit/env.
    # Only an explicit guard/comment mentioning it (to document the ban) is allowed —
    # never an assignment.
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue  # comments may name the var to document the ban
        assert "GUIDEMATE_ENABLE_MOTION=1" not in stripped, line
        assert "GUIDEMATE_ENABLE_MOTION=true" not in stripped, line


def test_installer_documents_the_ban():
    text = open(INSTALLER).read()
    assert "GUIDEMATE_ENABLE_MOTION" in text  # must at least mention it in a comment
    assert "sim" in text.lower()
