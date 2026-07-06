import logging

from guidemate_msgs.messages import Ack, Command

from guide_mate_bridge.executor import ChoreographyRunner


def _runner(acks, dry_run=True):
    return ChoreographyRunner(publish_ack=acks.append, dry_run=dry_run)


def test_happy_path_ack_sequence_dry_run():
    acks = []
    _runner(acks).handle(Command(type="emote", name="happy"))
    states = [a.state for a in acks]
    assert states == ["received", "running", "done"]
    assert acks[-1].simulated is True


def test_invalid_choreography_acks_failed():
    # Bypass Command validation to reach the executor's build() error path.
    cmd = Command.model_construct(
        cmd_id="x", type="emote", name="moonwalk", params={}, ts="t"
    )
    acks = []
    _runner(acks).handle(cmd)
    assert [a.state for a in acks] == ["received", "failed"]
    assert acks[-1].reason and "moonwalk" in acks[-1].reason


def test_dry_run_logs_twist_lines(caplog):
    acks = []
    with caplog.at_level(logging.INFO, logger="guide_mate_bridge.executor"):
        _runner(acks).handle(Command(type="motion", name="spin"))
    dry_lines = [r for r in caplog.records if r.getMessage().startswith("DRY-RUN twist")]
    assert len(dry_lines) == 1  # spin is a single step


def test_dry_run_never_publishes_twist():
    published = []
    runner = ChoreographyRunner(
        publish_ack=lambda a: None,
        dry_run=True,
        publish_twist=published.append,
    )
    runner.handle(Command(type="emote", name="yes"))
    assert published == []
