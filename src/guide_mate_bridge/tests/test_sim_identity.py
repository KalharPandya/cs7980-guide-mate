import os
import subprocess

HERE = os.path.dirname(__file__)
SCRIPT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "scripts", "create_sim_identity.sh"))


def test_script_exists_and_executable():
    assert os.path.isfile(SCRIPT), SCRIPT
    assert os.access(SCRIPT, os.X_OK), "create_sim_identity.sh must be chmod +x"


def test_script_is_valid_bash():
    # `bash -n` parses without executing — catches syntax errors safely.
    subprocess.run(["bash", "-n", SCRIPT], check=True)


def test_script_pins_the_locked_values():
    text = open(SCRIPT).read()
    assert "Turtlebot-Sim" in text
    assert "guidemate-sim-policy" in text
    assert "guidemate/turtlebotsim/*" in text
    assert "$aws/things/Turtlebot-Sim/shadow/*" in text
    # Default-deny shadow, identical to the real robot.
    assert '"motion_enabled": false' in text
    assert '"dry_run": true' in text
    assert '"max_speed": 0.15' in text
    assert "guidemate-sim.cert.pem" in text and "guidemate-sim.key.pem" in text
    assert "chmod 600" in text
    # Never touch robot 468.
    assert "turtlebot468" not in text
    assert "guidemate-poc" in text  # tagging convention
