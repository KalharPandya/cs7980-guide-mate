import os

import pytest
from datetime import datetime, timezone

from botocore.exceptions import ClientError, BotoCoreError

from guidemate_agent.kb import KBManager


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
