from guide_mate_bridge.safety import SafetyState


def test_defaults_locked():
    s = SafetyState()
    assert s.effective_dry_run is True
    assert s.max_speed == 0.15
    assert s.gates() == {"docked": None, "motion_enabled": False, "dry_run": True}


def test_apply_shadow_max_speed_clamped_to_hard_cap():
    s = SafetyState()
    s.apply_shadow({"max_speed": 5.0})
    assert s.max_speed == 0.15  # shadow can never loosen the hard cap
    s.apply_shadow({"max_speed": 0.10})
    assert s.max_speed == 0.10
    s.apply_shadow({"max_speed": "fast"})  # malformed -> ignored, keeps previous
    assert s.max_speed == 0.10
    s.apply_shadow({"max_speed": -1.0})
    assert s.max_speed == 0.0


def test_effective_dry_run_is_env_OR_shadow():
    env_on = SafetyState(env_dry_run=True)
    env_on.apply_shadow({"dry_run": False})
    assert env_on.effective_dry_run is True  # env=1 wins regardless of shadow

    env_off = SafetyState(env_dry_run=False)
    assert env_off.effective_dry_run is True  # shadow default still locks
    env_off.apply_shadow({"dry_run": False})
    assert env_off.effective_dry_run is False


def test_reported_dry_run_echoes_shadow_effective_separate():
    # reported.dry_run must echo the SHADOW-level value (so desired==reported converges,
    # no delta storm); the env-OR-shadow effective value is exposed separately.
    s = SafetyState(env_dry_run=True)
    s.apply_shadow({"dry_run": False, "motion_enabled": True, "max_speed": 0.10})
    rep = s.reported()
    assert rep == {"motion_enabled": True, "max_speed": 0.10,
                   "dry_run": False, "effective_dry_run": True}


def test_docked_and_uptime():
    s = SafetyState()
    s.set_docked(True)
    assert s.gates()["docked"] is True
    assert s.uptime_s() >= 0.0
