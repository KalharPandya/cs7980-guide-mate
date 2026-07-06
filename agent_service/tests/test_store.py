import pytest

from guidemate_agent.store import DEFAULT_FLAGS, ConfigStore
from scripts_create_dynamo_tables import table_specs


class FakeTable:
    """In-memory stand-in for a boto3 DynamoDB Table (pk-keyed)."""

    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["pk"])
        return {"Item": item} if item is not None else {}

    def put_item(self, Item):
        self.items[Item["pk"]] = dict(Item)


def test_default_flags_shape():
    assert DEFAULT_FLAGS == {
        "dog_muted": False,
        "emotes_enabled": True,
        "motion_tools_enabled": True,
        "persona_enabled": True,
        "kb_enabled": True,
    }


def test_get_flags_returns_defaults_when_empty():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    flags = store.get_flags()
    assert flags["dog_muted"] is False
    assert flags["emotes_enabled"] is True
    assert flags["kb_enabled"] is True


def test_set_flag_round_trips():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    store.set_flag("dog_muted", True)
    assert store.get_flags()["dog_muted"] is True
    # other flags keep their defaults
    assert store.get_flags()["emotes_enabled"] is True


def test_unknown_flag_rejected():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    with pytest.raises(ValueError):
        store.set_flag("does_not_exist", True)


def test_prompt_round_trips_and_clears():
    store = ConfigStore(table=FakeTable(), ttl_s=0.0)
    assert store.get_prompt() is None
    store.set_prompt("be terse")
    assert store.get_prompt() == "be terse"
    store.set_prompt(None)
    assert store.get_prompt() is None
    store.set_prompt("  ")  # blank clears too
    assert store.get_prompt() is None


def test_ttl_cache_hides_external_writes_until_invalidated():
    table = FakeTable()
    store = ConfigStore(table=table, ttl_s=100.0)
    assert store.get_flags()["dog_muted"] is False  # caches the empty read
    table.put_item(Item={"pk": "flags", "dog_muted": True})  # out-of-band write
    assert store.get_flags()["dog_muted"] is False  # still serving the cache
    store._invalidate("flags")
    assert store.get_flags()["dog_muted"] is True


def test_table_specs_cover_all_four_on_demand_tables():
    specs = table_specs()
    names = {s["TableName"] for s in specs}
    assert names == {
        "guidemate-sessions",
        "guidemate-messages",
        "guidemate-requests",
        "guidemate-config",
    }


def test_config_table_partition_key_is_pk():
    spec = next(s for s in table_specs() if s["TableName"] == "guidemate-config")
    assert spec["KeySchema"][0]["AttributeName"] == "pk"
