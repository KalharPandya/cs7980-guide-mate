import os

import pytest
from datetime import datetime, timezone

from guidemate_agent.kb import KBManager


class FakeS3:
    def __init__(self):
        self.objects = {}

    def list_objects_v2(self, Bucket):
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
    mgr.upload("notes.md", b"hello world")
    docs = mgr.list_docs()
    assert len(docs) == 1
    assert docs[0]["key"] == "notes.md"
    assert docs[0]["size"] == 11
    assert "2026-07-05" in docs[0]["modified"]
    mgr.delete("notes.md")
    assert mgr.list_docs() == []


def test_start_ingestion_returns_job_id():
    mgr = _manager()
    job_id = mgr.start_ingestion()
    assert job_id == "job-1"


def test_latest_job_status_none_then_complete():
    mgr = _manager()
    assert mgr.latest_job_status() == {"status": "NONE"}
    mgr.start_ingestion()
    status = mgr.latest_job_status()
    assert status["job_id"] == "job-1"
    assert status["status"] == "COMPLETE"


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
