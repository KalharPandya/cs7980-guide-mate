from guidemate_agent.autonomy import (
    AUTONOMY_SESSION_ID,
    FIRE_BELOW,
    RESET_ABOVE,
    RULES,
    LowBatteryDebouncer,
)


def test_constants():
    assert FIRE_BELOW == 0.15
    assert RESET_ABOVE == 0.25
    assert AUTONOMY_SESSION_ID == "system-autonomy"


def test_rules_are_data_with_expected_names():
    names = {rule["name"] for rule in RULES}
    assert names == {"low_battery", "robot_offline"}


def test_fires_once_on_crossing_below():
    d = LowBatteryDebouncer()
    assert d.update(0.30) is False   # armed, above threshold -> nothing
    assert d.update(0.12) is True    # crosses below -> fire
    assert d.update(0.10) is False   # still low, already fired -> no repeat
    assert d.update(0.14) is False   # still below -> no repeat


def test_rearms_only_after_recovery_above_reset():
    d = LowBatteryDebouncer()
    assert d.update(0.12) is True    # fire
    assert d.update(0.20) is False   # above fire_below but NOT above reset_above -> stay disarmed
    assert d.update(0.12) is False   # dipped again while disarmed -> no fire
    assert d.update(0.30) is False   # recovers above reset_above -> re-arm (no fire on the way up)
    assert d.update(0.12) is True    # next crossing fires again


def test_exactly_at_boundaries():
    d = LowBatteryDebouncer()
    assert d.update(0.15) is False   # not strictly below fire_below
    assert d.update(0.149) is True   # strictly below -> fire
    assert d.update(0.25) is False   # not strictly above reset_above -> stay disarmed
    assert d.update(0.2501) is False # re-arms, no fire on recovery
    assert d.update(0.149) is True   # fires again
