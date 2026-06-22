#!/usr/bin/env python3
"""
Tests for collect_claude_conversations.py

Run:  python scripts/test_collect_claude_conversations.py
(uses only the standard library; no pytest required)
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_claude_conversations as c  # noqa: E402


# A tiny base64 PNG-ish payload to prove images survive untouched.
IMG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"


def make_session_lines(cwd):
    """Build a realistic mix of session event lines for a given cwd."""
    return [
        # pure-metadata lines that MUST be dropped
        {"type": "mode", "sessionId": "s1", "mode": "default"},
        {"type": "permission-mode", "sessionId": "s1", "permissionMode": "ask"},
        {"type": "queue-operation", "sessionId": "s1", "operation": "x",
         "content": "y", "timestamp": "2026-06-20T10:00:00Z"},
        {"type": "last-prompt", "sessionId": "s1", "leafUuid": "u", "lastPrompt": "hi"},
        {"type": "system", "sessionId": "s1", "cwd": cwd, "subtype": "hook",
         "uuid": "sys1", "timestamp": "2026-06-20T10:00:01Z"},
        # a user line with metadata to strip + text to keep
        {"type": "user", "uuid": "u1", "parentUuid": "p0", "sessionId": "s1",
         "requestId": "r1", "version": "1.0", "entrypoint": "cli",
         "userType": "external", "isSidechain": False, "promptId": "pid1",
         "cwd": cwd, "gitBranch": "main", "timestamp": "2026-06-20T10:01:00Z",
         "message": {"role": "user", "content": "Hello GuideMate"}},
        # an assistant line with an IMAGE block that must be preserved exactly
        {"type": "assistant", "uuid": "a1", "parentUuid": "u1", "sessionId": "s1",
         "requestId": "r2", "version": "1.0", "timestamp": "2026-06-20T10:01:05Z",
         "message": {"role": "assistant", "content": [
             {"type": "text", "text": "Here is a diagram"},
             {"type": "image", "source": {"type": "base64",
                                          "media_type": "image/png",
                                          "data": IMG_DATA}},
         ]}},
        # an assistant line with a big tool_result (for --trim-tool-results test)
        {"type": "assistant", "uuid": "a2", "parentUuid": "a1", "sessionId": "s1",
         "timestamp": "2026-06-20T10:01:06Z",
         "message": {"role": "assistant", "content": [
             {"type": "tool_result", "content": "X" * 5000},
         ]}},
        # a file snapshot (kept by default, dropped with --drop-snapshots)
        {"type": "file-history-snapshot", "messageId": "m1",
         "isSnapshotUpdate": False, "snapshot": {"files": {"a.py": "code"}}},
    ]


def write_session(projects_dir, name, cwd):
    p = Path(projects_dir) / name
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as fh:
        for obj in make_session_lines(cwd):
            fh.write(json.dumps(obj) + "\n")
    return p


class MatchingTests(unittest.TestCase):
    def test_basename_match(self):
        self.assertTrue(c.cwd_matches(r"P:\CS7980\Project-code", ["Project-code"]))
        self.assertTrue(c.cwd_matches("/home/k/cs7980-guide-mate", ["cs7980-guide-mate"]))

    def test_basename_no_false_positive(self):
        self.assertFalse(c.cwd_matches(r"P:\Other\Thing", ["Project-code"]))

    def test_absolute_path_and_subtree(self):
        inc = ["P:/CS7980/Project-code"]
        self.assertTrue(c.cwd_matches(r"P:\CS7980\Project-code", inc))
        self.assertTrue(c.cwd_matches(r"P:\CS7980\Project-code\cs7980-guide-mate", inc))
        self.assertFalse(c.cwd_matches(r"P:\CS7980\Other", inc))

    def test_case_insensitive(self):
        self.assertTrue(c.cwd_matches(r"p:\cs7980\project-code", ["P:/CS7980/Project-code"]))

    def test_none_cwd(self):
        self.assertFalse(c.cwd_matches(None, ["Project-code"]))


class SlimTests(unittest.TestCase):
    def test_drop_line_types(self):
        for t in c.DROP_LINE_TYPES:
            self.assertIsNone(c.slim_line({"type": t}))

    def test_strip_keys_removed_content_kept(self):
        line = {"type": "user", "uuid": "x", "requestId": "r", "version": "1",
                "cwd": "/p", "timestamp": "t",
                "message": {"role": "user", "content": "hi"}}
        out = c.slim_line(line)
        for k in ("uuid", "requestId", "version"):
            self.assertNotIn(k, out)
        self.assertEqual(out["message"]["content"], "hi")
        self.assertEqual(out["cwd"], "/p")
        self.assertEqual(out["timestamp"], "t")

    def test_image_preserved_exactly(self):
        line = {"type": "assistant", "uuid": "x",
                "message": {"role": "assistant", "content": [
                    {"type": "image", "source": {"type": "base64",
                     "media_type": "image/png", "data": IMG_DATA}}]}}
        out = c.slim_line(line)
        img = out["message"]["content"][0]
        self.assertEqual(img["source"]["data"], IMG_DATA)
        self.assertEqual(img["source"]["media_type"], "image/png")

    def test_snapshot_kept_by_default_dropped_on_flag(self):
        snap = {"type": "file-history-snapshot", "snapshot": {"f": 1}}
        self.assertIsNotNone(c.slim_line(snap))
        self.assertIsNone(c.slim_line(snap, drop_snapshots=True))

    def test_trim_tool_results(self):
        line = {"type": "assistant",
                "message": {"role": "assistant", "content": [
                    {"type": "tool_result", "content": "X" * 5000}]}}
        untrimmed = c.slim_line(line)
        self.assertEqual(len(untrimmed["message"]["content"][0]["content"]), 5000)
        trimmed = c.slim_line(line, trim_tool_results=True)
        self.assertLess(len(trimmed["message"]["content"][0]["content"]), 5000)
        self.assertTrue(trimmed["message"]["content"][0]["content"].endswith("[trimmed]"))


# ----------------------------------------------------------------------------
# Extensive credential corpus. Each entry: (label, secret_string_that_must_die).
# Every one must be (a) detected by find_secrets, (b) removed by redaction, and
# (c) absent from find_secrets after redaction.
# ----------------------------------------------------------------------------
SECRET_SAMPLES = [
    ("aws_access_key_id", "AKIAS5OHIRKDBY6VUUFF"),
    ("aws_temp_key_id", "ASIA1234567890ABCDEF"),
    ("aws_secret_access_key", "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    ("aws_session_token_assign", "aws_session_token: FQoGZXIvYXdzEABCDEFGHIJKLMNOP1234567890"),
    ("aws_presign_signature", "X-Amz-Signature=" + "a1b2c3d4" * 8),
    ("aws_presign_token", "X-Amz-Security-Token=IQoJb3JpZ2luX2VjEAbcdEFGhiJK&X-Amz-Date=x"),
    ("github_classic_pat", "ghp_" + "A" * 36),
    ("github_oauth", "gho_" + "B" * 36),
    ("github_fine_grained", "github_pat_" + "C" * 40),
    ("openai_key", "sk-" + "D" * 40),
    ("stripe_live", "sk_live_" + "E" * 24),
    ("stripe_pub", "pk_test_" + "F" * 24),
    ("slack_bot", "xoxb-123456789012-1234567890123-" + "G" * 24),
    ("google_api_key", "AIza" + "H" * 35),
    ("google_oauth", "ya29." + "I" * 40),
    ("jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "J" * 20),
    ("rsa_private_key",
     "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...secret...\n-----END RSA PRIVATE KEY-----"),
    ("openssh_private_key",
     "-----BEGIN OPENSSH PRIVATE KEY-----\nabc...\n-----END OPENSSH PRIVATE KEY-----"),
    ("bearer_token", "Authorization: Bearer " + "K" * 40),
    ("basic_auth", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=="),
    ("postgres_url", "postgres://admin:S3cr3tP@ss@db.example.com:5432/app"),
    ("mongodb_url", "mongodb://root:hunter2pass@mongo.internal:27017"),
    ("generic_api_key", "API_KEY=abcdef0123456789abcdef"),
    ("client_secret", 'client_secret: "8f3c9a2b1d4e6f7081927364"'),
    ("password_assign", "password=SuperSecret123"),
    ("password_backtick", "set the password `kalhar` now"),
]

# Strings that look secret-ish but are benign prose and must NOT be mangled.
BENIGN_SAMPLES = [
    "please use a password manager.",
    "rotate your secret regularly",
    "the token endpoint returns JSON",
    "Algorithm=AWS4-HMAC-SHA256 is the signing scheme",
    "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\nfingerprint here",
]


class RedactionCorpusTests(unittest.TestCase):
    def test_every_secret_detected_raw(self):
        for label, secret in SECRET_SAMPLES:
            with self.subTest(label=label):
                self.assertTrue(c.find_secrets(secret),
                                f"{label}: detector missed raw secret")

    def test_every_secret_redacted_and_gone(self):
        for label, secret in SECRET_SAMPLES:
            with self.subTest(label=label):
                line = {"type": "user",
                        "message": {"role": "user", "content": secret}}
                out_text = json.dumps(c.slim_line(line))
                # the sensitive *value* must not survive
                self.assertIn("REDACTED", out_text, f"{label}: not redacted")
                # and the verifier must find nothing left
                self.assertEqual(c.find_secrets(out_text), [],
                                 f"{label}: residual secret after redaction")

    def test_benign_prose_survives(self):
        for text in BENIGN_SAMPLES:
            with self.subTest(text=text[:30]):
                line = {"type": "user",
                        "message": {"role": "user", "content": text}}
                out = c.slim_line(line)
                self.assertEqual(c.find_secrets(json.dumps(out)), [],
                                 "benign text should not be flagged as secret")

    def test_pgp_signed_message_not_treated_as_private_key(self):
        # signed message is not a private key and must be left intact
        text = "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\nbody\n"
        line = {"type": "user", "message": {"role": "user", "content": text}}
        out = c.slim_line(line)
        self.assertIn("PGP SIGNED MESSAGE", out["message"]["content"])

    def test_image_data_never_redacted(self):
        # base64 data containing an AKIA-looking run must stay byte-for-byte
        payload = "AKIA" + "A" * 16 + IMG_DATA
        line = {"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "image", "source": {"type": "base64",
             "media_type": "image/png", "data": payload}}]}}
        out = c.slim_line(line)
        self.assertEqual(out["message"]["content"][0]["source"]["data"], payload)

    def test_no_redact_flag_keeps_secret(self):
        line = {"type": "user", "message": {"role": "user",
                "content": "AKIAS5OHIRKDBY6VUUFF"}}
        out = c.slim_line(line, redact=False)
        self.assertIn("AKIAS5OHIRKDBY6VUUFF", json.dumps(out))

    def test_redaction_is_idempotent(self):
        # redacting already-redacted text must not change it or re-flag
        for _, secret in SECRET_SAMPLES:
            once = c.redact_text(secret)
            twice = c.redact_text(once)
            self.assertEqual(once, twice)
            self.assertEqual(c.find_secrets(twice), [])


class VerificationGateTests(unittest.TestCase):
    """The end-to-end gate: a real collection must leave zero secrets on disk."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name) / "projects"
        self.out = Path(self.tmp.name) / "out"
        # a session whose content is stuffed with every secret type
        p = self.projects / "P--CS7980-Project-code" / "leaky-1234abcd.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "user", "cwd": r"P:\CS7980\Project-code",
                                 "timestamp": "2026-06-20T10:00:00Z", "uuid": "x",
                                 "message": {"role": "user", "content":
                                             " ".join(s for _, s in SECRET_SAMPLES)}}) + "\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_collection_leaves_no_secrets_on_disk(self):
        c.collect(self.projects, self.out, ["Project-code"])
        findings = c.scan_dir_for_secrets(self.out)
        self.assertEqual(findings, {}, f"secrets leaked to disk: {findings}")

    def test_gate_detects_when_redaction_disabled(self):
        c.collect(self.projects, self.out, ["Project-code"], redact=False)
        findings = c.scan_dir_for_secrets(self.out)
        self.assertTrue(findings, "gate failed to catch un-redacted secrets")

    def test_main_returns_nonzero_when_secrets_present(self):
        # write a raw secret into the output dir, then run --verify-only
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "leak.jsonl").write_text(
            json.dumps({"type": "user", "message":
                        {"role": "user", "content": "AKIAS5OHIRKDBY6VUUFF"}}) + "\n",
            encoding="utf-8")
        rc = c.main(["--verify-only", "--out", str(self.out),
                     "--projects-dir", str(self.projects)])
        self.assertEqual(rc, 3)

    def test_verify_only_passes_on_clean_dir(self):
        c.collect(self.projects, self.out, ["Project-code"])
        rc = c.main(["--verify-only", "--out", str(self.out),
                     "--projects-dir", str(self.projects)])
        self.assertEqual(rc, 0)


class CollectIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name) / "projects"
        self.out = Path(self.tmp.name) / "out"
        # a matching session + a non-matching one
        write_session(self.projects, "P--CS7980-Project-code/sess-aaaa1111.jsonl",
                      r"P:\CS7980\Project-code")
        write_session(self.projects, "P--Other-Thing/sess-bbbb2222.jsonl",
                      r"P:\Other\Thing")

    def tearDown(self):
        self.tmp.cleanup()

    def test_only_matching_collected(self):
        res = c.collect(self.projects, self.out, ["Project-code"])
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["source"].name, "sess-aaaa1111.jsonl")

    def test_output_filename_and_content(self):
        c.collect(self.projects, self.out, ["Project-code"])
        files = list(self.out.glob("*.jsonl"))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].name, "2026-06-20_sess-aaa.jsonl")
        lines = [json.loads(x) for x in files[0].read_text(encoding="utf-8").splitlines()]
        types = [o["type"] for o in lines]
        # metadata line-types gone; conversation + snapshot kept
        self.assertNotIn("mode", types)
        self.assertNotIn("system", types)
        self.assertIn("user", types)
        self.assertIn("assistant", types)
        self.assertIn("file-history-snapshot", types)
        # image survived
        joined = files[0].read_text(encoding="utf-8")
        self.assertIn(IMG_DATA, joined)

    def test_idempotent(self):
        c.collect(self.projects, self.out, ["Project-code"])
        first = (self.out / "2026-06-20_sess-aaa.jsonl").read_text(encoding="utf-8")
        c.collect(self.projects, self.out, ["Project-code"])
        second = (self.out / "2026-06-20_sess-aaa.jsonl").read_text(encoding="utf-8")
        self.assertEqual(first, second)
        self.assertEqual(len(list(self.out.glob("*.jsonl"))), 1)

    def test_dry_run_writes_nothing(self):
        c.collect(self.projects, self.out, ["Project-code"], dry_run=True)
        self.assertFalse(self.out.exists() and any(self.out.glob("*.jsonl")))

    def test_configurable_include_by_absolute_path(self):
        res = c.collect(self.projects, self.out, [r"P:\Other\Thing"])
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["source"].name, "sess-bbbb2222.jsonl")

    def test_no_match_returns_empty(self):
        res = c.collect(self.projects, self.out, ["does-not-exist"])
        self.assertEqual(res, [])


class IncludeResolutionTests(unittest.TestCase):
    """Hermetic: neutralize the repo's real auto-config so tests are deterministic."""

    def setUp(self):
        self._orig_auto = c.auto_config_path
        # point auto-config at a path that does not exist
        c.auto_config_path = lambda: Path(tempfile.gettempdir()) / "no_such_collect.json"

    def tearDown(self):
        c.auto_config_path = self._orig_auto

    def _args(self, **kw):
        ns = c.parse_args([])
        for k, v in kw.items():
            setattr(ns, k, v)
        return ns

    def test_cli_include_wins(self):
        self.assertEqual(c.resolve_includes(self._args(include=["A", "B"])), ["A", "B"])

    def test_config_file(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "cfg.json"
            cfg.write_text(json.dumps({"include": ["FromConfig"]}), encoding="utf-8")
            self.assertEqual(
                c.resolve_includes(self._args(include=None, config=str(cfg))),
                ["FromConfig"])

    def test_env_var(self):
        old = os.environ.get(c.ENV_INCLUDE)
        try:
            os.environ[c.ENV_INCLUDE] = os.pathsep.join(["EnvA", "EnvB"])
            self.assertEqual(
                c.resolve_includes(self._args(include=None, config=None)),
                ["EnvA", "EnvB"])
        finally:
            if old is None:
                os.environ.pop(c.ENV_INCLUDE, None)
            else:
                os.environ[c.ENV_INCLUDE] = old

    def test_default_fallback(self):
        old = os.environ.pop(c.ENV_INCLUDE, None)
        try:
            # only valid when no auto-config file exists in the repo
            if c.auto_config_path().is_file():
                self.skipTest("auto-config present")
            self.assertEqual(
                c.resolve_includes(self._args(include=None, config=None)),
                c.DEFAULT_INCLUDES)
        finally:
            if old is not None:
                os.environ[c.ENV_INCLUDE] = old


if __name__ == "__main__":
    unittest.main(verbosity=2)
