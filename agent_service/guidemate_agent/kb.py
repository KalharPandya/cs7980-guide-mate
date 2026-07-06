"""Knowledge-base document management for the dog-agent POC.

`KBManager` is the admin-side surface: it lists / uploads / deletes documents in
the KB's S3 bucket and drives Bedrock knowledge-base ingestion jobs so newly
uploaded docs get (re)indexed. Boto3 clients are injectable so unit tests can run
against fakes/stubs without touching AWS.
"""

import boto3


class KBManager:
    """Admin-side KB document management: S3 docs + Bedrock ingestion jobs."""

    def __init__(
        self,
        bucket: str,
        kb_id: str,
        data_source_id: str,
        region: str = "us-west-2",
        s3=None,
        agent=None,
    ) -> None:
        self._bucket = bucket
        self._kb_id = kb_id
        self._ds = data_source_id
        self._s3 = s3 or boto3.client("s3", region_name=region)
        self._agent = agent or boto3.client("bedrock-agent", region_name=region)

    def list_docs(self) -> list:
        resp = self._s3.list_objects_v2(Bucket=self._bucket)
        out = []
        for obj in resp.get("Contents", []):
            out.append(
                {
                    "key": obj["Key"],
                    "size": obj["Size"],
                    "modified": obj["LastModified"].isoformat(),
                }
            )
        return out

    def upload(self, key: str, data: bytes) -> None:
        self._s3.put_object(Bucket=self._bucket, Key=key, Body=data)

    def delete(self, key: str) -> None:
        self._s3.delete_object(Bucket=self._bucket, Key=key)

    def start_ingestion(self) -> str:
        resp = self._agent.start_ingestion_job(
            knowledgeBaseId=self._kb_id, dataSourceId=self._ds
        )
        return resp["ingestionJob"]["ingestionJobId"]

    def latest_job_status(self) -> dict:
        resp = self._agent.list_ingestion_jobs(
            knowledgeBaseId=self._kb_id,
            dataSourceId=self._ds,
            maxResults=1,
            sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
        )
        jobs = resp.get("ingestionJobSummaries", [])
        if not jobs:
            return {"status": "NONE"}
        job = jobs[0]
        return {"job_id": job["ingestionJobId"], "status": job["status"]}
