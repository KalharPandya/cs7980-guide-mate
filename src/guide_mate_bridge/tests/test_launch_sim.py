"""Smoke tests for sim/launch_sim.sh (P8-T5).

Side-effect-free: never actually launches Gazebo/Ignition (that's P8-T6's job) or
touches the network. Just proves the script is syntactically valid bash, sets the
right sim env, and structurally can never point itself at robot 468.
"""
import os
import subprocess

HERE = os.path.dirname(__file__)
SCRIPT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sim", "launch_sim.sh"))


def test_script_exists_and_executable():
    assert os.path.isfile(SCRIPT), SCRIPT
    assert os.access(SCRIPT, os.X_OK), "launch_sim.sh must be chmod +x"


def test_script_is_valid_bash():
    # `bash -n` parses without executing — catches syntax errors safely.
    subprocess.run(["bash", "-n", SCRIPT], check=True)


def test_script_uses_sim_identity_never_468():
    text = open(SCRIPT).read()
    assert "GUIDEMATE_ROBOT_ID=turtlebotsim" in text
    assert "GUIDEMATE_THING_NAME=Turtlebot-Sim" in text
    assert "guidemate-sim.cert.pem" in text and "guidemate-sim.key.pem" in text
    # Never sets/exports robot 468's identity (a bare mention in a comment explaining
    # why the guard doesn't fire here is fine; an assignment/export is not).
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        assert "turtlebot468" not in stripped, line
        assert "Turtlebot-468" not in stripped, line


def test_script_arms_motion_but_stays_shadow_gated():
    text = open(SCRIPT).read()
    # Motion env is armed (safe ONLY because robot_id=turtlebotsim, see bridge.py
    # assert_motion_identity_safe) but the shadow sync must be on too, or the sim
    # shadow's default-deny lock can never be reconciled/observed at all.
    assert "GUIDEMATE_ENABLE_MOTION=1" in text
    assert "GUIDEMATE_SHADOW=1" in text
    assert "GUIDEMATE_DRY_RUN=0" in text


def test_script_unsets_ros_discovery_server():
    # GOTCHA: the login profile's ROS_DISCOVERY_SERVER breaks sim DDS discovery.
    text = open(SCRIPT).read()
    assert "unset ROS_DISCOVERY_SERVER" in text
    assert "ros2 daemon stop" in text  # must restart the daemon so it forgets


def test_script_sets_empty_ros_namespace_for_unnamespaced_sim():
    # The sim graph is UN-namespaced (root /battery_state, /dock_status). Left at the
    # bridge's default (namespace = GUIDEMATE_ROBOT_ID), telemetry would subscribe to
    # nonexistent /turtlebotsim/battery_state + /turtlebotsim/dock_status and the
    # dock-guard could never open. This must be forced empty.
    text = open(SCRIPT).read()
    assert 'GUIDEMATE_ROS_NAMESPACE=""' in text


def test_script_never_execs_bridge_before_cleanup_trap():
    # A bare `exec` of the bridge would replace the shell (and its EXIT trap), leaving
    # the sim process orphaned when the bridge exits. The bridge must run un-exec'd so
    # the trap-based sim cleanup still fires.
    text = open(SCRIPT).read()
    assert "trap cleanup EXIT" in text
    for line in text.splitlines():
        assert "exec " + '"$REPO/.venv/bin/python"' not in line
