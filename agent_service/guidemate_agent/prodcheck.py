"""Assertions for the production / compose chat round-trip slice check."""
from __future__ import annotations


def assert_chat_roundtrip(payload: dict) -> None:
    if payload.get("emote") is None:
        raise AssertionError("no emote in chat response")
    acks = payload.get("robot") or []
    if not any(a.get("simulated") is True for a in acks):
        raise AssertionError("no simulated ack in robot round-trip")
