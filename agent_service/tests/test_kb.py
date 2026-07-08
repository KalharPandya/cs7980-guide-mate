import os

import pytest
from datetime import datetime, timezone

from botocore.exceptions import ClientError, BotoCoreError

from guidemate_agent.kb import (
    KBManager,
    retrieve_passages,
    retrieve_passages_with_sources,
)


class FakeS3:
    def __init__(self):
        self.objects = {}

    def list_objects_v2(self, Bucket, ContinuationToken=None):
        if not self.objects:
            return {}
        return {
            "Contents": [
                {
                    "Key": key,
                    "Size": len(body),
                    "LastModified": datetime(2026, 7, 5, tzinfo=timezone.utc),
                }
                for key, body in self.objects.items()
            ]
        }

    def put_object(self, Bucket, Key, Body):
        self.objects[Key] = Body

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)


class FakePaginatedS3:
    """Two-page S3 listing to exercise the pagination loop."""

    def __init__(self):
        self._pages = [
            {
                "IsTruncated": True,
                "NextContinuationToken": "token-1",
                "Contents": [
                    {
                        "Key": "a.md",
                        "Size": 1,
                        "LastModified": datetime(2026, 7, 5, tzinfo=timezone.utc),
                    }
                ],
            },
            {
                "IsTruncated": False,
                "Contents": [
                    {
                        "Key": "b.md",
                        "Size": 2,
                        "LastModified": datetime(2026, 7, 5, tzinfo=timezone.utc),
                    }
                ],
            },
        ]
        self.calls = []

    def list_objects_v2(self, Bucket, ContinuationToken=None):
        self.calls.append(ContinuationToken)
        if ContinuationToken is None:
            return self._pages[0]
        assert ContinuationToken == "token-1"
        return self._pages[1]


class RaisingS3:
    """Every method raises a botocore-style error."""

    def __init__(self, exc):
        self._exc = exc

    def list_objects_v2(self, Bucket, ContinuationToken=None):
        raise self._exc

    def put_object(self, Bucket, Key, Body):
        raise self._exc

    def delete_object(self, Bucket, Key):
        raise self._exc


class RaisingBedrockAgent:
    def __init__(self, exc):
        self._exc = exc

    def start_ingestion_job(self, knowledgeBaseId, dataSourceId):
        raise self._exc

    def list_ingestion_jobs(self, knowledgeBaseId, dataSourceId, maxResults=1, sortBy=None):
        raise self._exc


def _client_error(op_name="ListObjectsV2"):
    return ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "not allowed"}}, op_name
    )


class FakeBedrockAgent:
    def __init__(self):
        self.jobs = []

    def start_ingestion_job(self, knowledgeBaseId, dataSourceId):
        job_id = f"job-{len(self.jobs) + 1}"
        self.jobs.append({"ingestionJobId": job_id, "status": "STARTING"})
        return {"ingestionJob": {"ingestionJobId": job_id, "status": "STARTING"}}

    def list_ingestion_jobs(self, knowledgeBaseId, dataSourceId, maxResults=1, sortBy=None):
        if not self.jobs:
            return {"ingestionJobSummaries": []}
        latest = self.jobs[-1]
        return {"ingestionJobSummaries": [{**latest, "status": "COMPLETE"}]}


def _manager():
    return KBManager(
        bucket="guidemate-kb-docs-852373397000",
        kb_id="A1NIQYZ0KQ",
        data_source_id="OT8JLH57TE",
        s3=FakeS3(),
        agent=FakeBedrockAgent(),
    )


def test_upload_then_list_then_delete():
    mgr = _manager()
    assert mgr.list_docs() == []
    result = mgr.upload("notes.md", b"hello world")
    assert result == {"ok": True}
    docs = mgr.list_docs()
    assert len(docs) == 1
    assert docs[0]["key"] == "notes.md"
    assert docs[0]["size"] == 11
    assert "2026-07-05" in docs[0]["modified"]
    result = mgr.delete("notes.md")
    assert result == {"ok": True}
    assert mgr.list_docs() == []


def test_start_ingestion_returns_job_id():
    mgr = _manager()
    result = mgr.start_ingestion()
    assert result == {"ok": True, "job_id": "job-1"}


def test_latest_job_status_none_then_complete():
    mgr = _manager()
    assert mgr.latest_job_status() == {"status": "NONE"}
    mgr.start_ingestion()
    status = mgr.latest_job_status()
    assert status["job_id"] == "job-1"
    assert status["status"] == "COMPLETE"


def test_list_docs_paginates_across_multiple_pages():
    fake_s3 = FakePaginatedS3()
    mgr = KBManager(
        bucket="guidemate-kb-docs-852373397000",
        kb_id="A1NIQYZ0KQ",
        data_source_id="OT8JLH57TE",
        s3=fake_s3,
        agent=FakeBedrockAgent(),
    )
    docs = mgr.list_docs()
    assert [d["key"] for d in docs] == ["a.md", "b.md"]
    assert fake_s3.calls == [None, "token-1"]


def test_list_docs_returns_empty_list_on_client_error():
    mgr = KBManager(
        bucket="b",
        kb_id="k",
        data_source_id="d",
        s3=RaisingS3(_client_error()),
        agent=FakeBedrockAgent(),
    )
    assert mgr.list_docs() == []


def test_list_docs_returns_empty_list_on_botocore_error():
    mgr = KBManager(
        bucket="b",
        kb_id="k",
        data_source_id="d",
        s3=RaisingS3(BotoCoreError()),
        agent=FakeBedrockAgent(),
    )
    assert mgr.list_docs() == []


def test_upload_returns_error_shape_on_client_error():
    mgr = KBManager(
        bucket="b",
        kb_id="k",
        data_source_id="d",
        s3=RaisingS3(_client_error("PutObject")),
        agent=FakeBedrockAgent(),
    )
    result = mgr.upload("notes.md", b"hello")
    assert result["ok"] is False
    assert "error" in result


def test_delete_returns_error_shape_on_client_error():
    mgr = KBManager(
        bucket="b",
        kb_id="k",
        data_source_id="d",
        s3=RaisingS3(_client_error("DeleteObject")),
        agent=FakeBedrockAgent(),
    )
    result = mgr.delete("notes.md")
    assert result["ok"] is False
    assert "error" in result


def test_start_ingestion_returns_error_shape_on_client_error():
    mgr = KBManager(
        bucket="b",
        kb_id="k",
        data_source_id="d",
        s3=FakeS3(),
        agent=RaisingBedrockAgent(_client_error("StartIngestionJob")),
    )
    result = mgr.start_ingestion()
    assert result["ok"] is False
    assert "error" in result


def test_latest_job_status_returns_error_shape_on_client_error():
    mgr = KBManager(
        bucket="b",
        kb_id="k",
        data_source_id="d",
        s3=FakeS3(),
        agent=RaisingBedrockAgent(_client_error("ListIngestionJobs")),
    )
    result = mgr.latest_job_status()
    assert result["status"] == "ERROR"
    assert "error" in result


# --- retrieve_passages (agent-side KB retrieval tool) ---------------------
class FakeKBRuntime:
    """Injectable stand-in for a bedrock-agent-runtime client."""

    def __init__(self, results=None, boom=False):
        self._results = results or []
        self._boom = boom
        self.calls = []

    def retrieve(self, **kwargs):
        self.calls.append(kwargs)
        if self._boom:
            raise RuntimeError("bedrock exploded")
        return {"retrievalResults": self._results}


def _kb_result(text, uri):
    return {"content": {"text": text}, "location": {"s3Location": {"uri": uri}}}


def test_retrieve_concatenates_passages_with_sources():
    client = FakeKBRuntime(
        results=[
            _kb_result("Moses is a TurtleBot 4.", "s3://guidemate-kb-docs/moses.md"),
            _kb_result("Moses maps indoor spaces.", "s3://guidemate-kb-docs/moses.md"),
        ]
    )
    out = retrieve_passages("who is moses", "A1NIQYZ0KQ", client=client)
    assert "Moses is a TurtleBot 4." in out
    assert "Moses maps indoor spaces." in out
    assert "s3://guidemate-kb-docs/moses.md" in out
    # kb_id + top_k propagated into the request
    assert client.calls[0]["knowledgeBaseId"] == "A1NIQYZ0KQ"
    cfg = client.calls[0]["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert cfg["numberOfResults"] == 4


def test_retrieve_defaults_kb_id_from_env(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_KB_ID", raising=False)
    client = FakeKBRuntime(results=[_kb_result("x", "s3://b/k")])
    retrieve_passages("q", client=client)
    # falls back to the default KB id when neither arg nor env is set
    assert client.calls[0]["knowledgeBaseId"] == "A1NIQYZ0KQ"


def test_retrieve_env_kb_id_overrides_default(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_KB_ID", "ENVKB123")
    client = FakeKBRuntime(results=[_kb_result("x", "s3://b/k")])
    retrieve_passages("q", client=client)
    assert client.calls[0]["knowledgeBaseId"] == "ENVKB123"


def test_retrieve_missing_source_uses_placeholder():
    client = FakeKBRuntime(results=[{"content": {"text": "orphan passage"}}])
    out = retrieve_passages("q", "A1NIQYZ0KQ", client=client)
    assert "orphan passage" in out
    assert "unknown-source" in out


def test_retrieve_empty_results_message():
    out = retrieve_passages("nothing", "A1NIQYZ0KQ", client=FakeKBRuntime(results=[]))
    assert out == "no relevant knowledge found"


def test_retrieve_error_is_swallowed():
    out = retrieve_passages("boom", "A1NIQYZ0KQ", client=FakeKBRuntime(boom=True))
    assert out == "knowledge base unavailable"


# --- retrieve_passages_with_sources (citation capture) --------------------
def test_with_sources_returns_dedup_titles():
    client = FakeKBRuntime(
        results=[
            _kb_result("Moses is a TurtleBot 4.", "s3://guidemate-kb-docs/moses-facts.md"),
            _kb_result("Moses maps indoor spaces.", "s3://guidemate-kb-docs/moses-facts.md"),
            _kb_result("Glass handling is layered.", "s3://guidemate-kb-docs/glass.md"),
        ]
    )
    text, sources = retrieve_passages_with_sources("q", "A1NIQYZ0KQ", client=client)
    assert "Moses is a TurtleBot 4." in text             # text half unchanged
    # doc keys (basename of the S3 uri), de-duplicated in first-seen order, url null
    assert sources == [
        {"title": "moses-facts.md", "url": None},
        {"title": "glass.md", "url": None},
    ]


def test_with_sources_text_matches_retrieve_passages():
    results = [_kb_result("x", "s3://b/doc.md")]
    text, _ = retrieve_passages_with_sources("q", "K", client=FakeKBRuntime(results=results))
    plain = retrieve_passages("q", "K", client=FakeKBRuntime(results=results))
    assert text == plain


def test_with_sources_empty_and_error_have_no_sources():
    _text, empty = retrieve_passages_with_sources("q", "K", client=FakeKBRuntime(results=[]))
    assert empty == []
    _text, boom = retrieve_passages_with_sources("q", "K", client=FakeKBRuntime(boom=True))
    assert boom == []


def test_with_sources_skips_unknown_source_placeholder():
    client = FakeKBRuntime(results=[{"content": {"text": "orphan"}}])
    text, sources = retrieve_passages_with_sources("q", "K", client=client)
    assert "orphan" in text
    assert sources == []  # placeholder 'unknown-source' is not a real citation


@pytest.mark.skipif(
    os.environ.get("GUIDEMATE_LIVE_KB") != "1",
    reason="set GUIDEMATE_LIVE_KB=1 to exercise the real Bedrock KB retrieval",
)
def test_live_kb_retrieve_finds_moses():
    """Env-gated live retrieval against the real KB (seeded with the Moses docs)."""
    out = retrieve_passages("who is Moses", "A1NIQYZ0KQ")
    assert isinstance(out, str) and out
    assert "Moses" in out
    print("live retrieve_passages ->", out)


@pytest.mark.skipif(
    os.environ.get("GUIDEMATE_LIVE_KB") != "1",
    reason="set GUIDEMATE_LIVE_KB=1 to exercise the real S3 bucket + Bedrock KB",
)
def test_live_list_docs_against_real_bucket():
    """Env-gated smoke test against the real KB stack (us-west-2)."""
    mgr = KBManager(
        bucket="guidemate-kb-docs-852373397000",
        kb_id="A1NIQYZ0KQ",
        data_source_id="OT8JLH57TE",
    )
    docs = mgr.list_docs()
    assert isinstance(docs, list)
    for d in docs:
        assert set(d.keys()) == {"key", "size", "modified"}
    status = mgr.latest_job_status()
    assert "status" in status
    print("live list_docs ->", docs)
    print("live latest_job_status ->", status)
