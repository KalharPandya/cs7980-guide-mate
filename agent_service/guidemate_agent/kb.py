"""Knowledge-base access for the dog-agent POC.

Two surfaces live here:

* `retrieve_passages` — the *agent-side* read path: the body of the `retrieve_kb`
  tool the model calls to ground a factual answer. It hits
  `bedrock-agent-runtime.retrieve` for the top-k passages and **degrades
  gracefully** — any error becomes the literal string "knowledge base
  unavailable" so the agent still answers (just ungrounded), never a raised
  exception in the turn loop.
* `KBManager` — the *admin-side* surface: it lists / uploads / deletes documents
  in the KB's S3 bucket and drives Bedrock knowledge-base ingestion jobs so newly
  uploaded docs get (re)indexed.

Boto3 clients are injectable everywhere so unit tests can run against
fakes/stubs without touching AWS. `KBManager`'s methods wrap their AWS calls in a
try/except for `botocore.exceptions.ClientError` / `BotoCoreError` so a transient
AWS failure degrades to a safe, loggable return value instead of an unhandled
exception bubbling up into the FastAPI layer.
"""

import logging
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)

_AWS_ERRORS = (ClientError, BotoCoreError)

# Default KB id (the POC's Bedrock knowledge base, seeded with the Moses docs).
# Overridable via the GUIDEMATE_KB_ID env var or an explicit `kb_id` arg.
_DEFAULT_KB_ID = "A1NIQYZ0KQ"
_DEFAULT_REGION = "us-west-2"

_KB_UNAVAILABLE = "knowledge base unavailable"
_KB_EMPTY = "no relevant knowledge found"


def _source_title(uri: str) -> str:
    """Human-facing doc title from an S3 source URI: its basename (e.g.
    ``s3://bucket/moses-facts.md`` -> ``moses-facts.md``). Falls back to the
    raw URI when it has no path segment."""
    if not uri:
        return "unknown-source"
    tail = uri.rstrip("/").rsplit("/", 1)[-1]
    return tail or uri


def retrieve_passages_with_sources(
    query: str,
    kb_id: str | None = None,
    region: str | None = None,
    top_k: int = 4,
    client=None,
) -> tuple[str, list[dict]]:
    """Like :func:`retrieve_passages`, but also returns the ordered, de-duplicated
    list of citation sources used for the answer.

    Returns ``(text, sources)`` where ``sources`` is a list of
    ``{"title": <doc key/name>, "url": <str|None>}`` (``url`` is always ``None``
    for the S3-backed KB — there is no public link). ``sources`` is empty on any
    error, on an empty KB result, and for the placeholder ``unknown-source``. The
    ``text`` half is byte-for-byte what :func:`retrieve_passages` produces.
    """
    kb_id = kb_id or os.environ.get("GUIDEMATE_KB_ID") or _DEFAULT_KB_ID
    region = region or os.environ.get("AWS_REGION") or _DEFAULT_REGION
    try:
        client = client or boto3.client("bedrock-agent-runtime", region_name=region)
        resp = client.retrieve(
            knowledgeBaseId=kb_id,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": top_k}
            },
        )
    except Exception:  # noqa: BLE001 — degrade gracefully, agent still answers
        logger.exception("KB retrieve failed for kb_id=%s", kb_id)
        return _KB_UNAVAILABLE, []
    results = resp.get("retrievalResults", [])
    if not results:
        return _KB_EMPTY, []
    blocks = []
    sources: list[dict] = []
    seen: set[str] = set()
    for item in results:
        text = item.get("content", {}).get("text", "").strip()
        src = (
            item.get("location", {})
            .get("s3Location", {})
            .get("uri", "unknown-source")
        )
        blocks.append(f"[{src}] {text}")
        # Real sources only (skip the placeholder), de-duplicated in first-seen
        # order so a doc spanning several passages appears once in the citation.
        if src and src != "unknown-source":
            title = _source_title(src)
            if title not in seen:
                seen.add(title)
                sources.append({"title": title, "url": None})
    return "\n\n".join(blocks), sources


def retrieve_passages(
    query: str,
    kb_id: str | None = None,
    region: str | None = None,
    top_k: int = 4,
    client=None,
) -> str:
    """Top-k KB passages for `query`, concatenated with their source keys.

    Each result becomes a ``"[<source-uri>] <text>"`` block; blocks are joined by
    blank lines. Returns "knowledge base unavailable" on *any* error (so the agent
    still answers, just without grounding) and "no relevant knowledge found" when
    the KB returns nothing.

    `kb_id` falls back to the GUIDEMATE_KB_ID env var, then a baked-in default.
    `client` is injectable for offline tests. Thin wrapper over
    :func:`retrieve_passages_with_sources` (returns only the text half).
    """
    text, _sources = retrieve_passages_with_sources(
        query, kb_id=kb_id, region=region, top_k=top_k, client=client
    )
    return text


def _safe_error(exc: Exception) -> str:
    """Non-leaky error string for API responses: the full message is logged
    server-side by callers, but callers/clients only ever see the exception's
    class name so AWS error details (bucket names, ARNs, request ids, ...)
    never reach a response body."""
    return f"{exc.__class__.__name__} (see logs)"


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

    def list_docs(self) -> list[dict]:
        out: list[dict] = []
        try:
            token = None
            while True:
                kwargs = {"Bucket": self._bucket}
                if token:
                    kwargs["ContinuationToken"] = token
                resp = self._s3.list_objects_v2(**kwargs)
                for obj in resp.get("Contents", []):
                    out.append(
                        {
                            "key": obj["Key"],
                            "size": obj["Size"],
                            "modified": obj["LastModified"].isoformat(),
                        }
                    )
                if not resp.get("IsTruncated"):
                    break
                token = resp.get("NextContinuationToken")
                if not token:
                    break
        except _AWS_ERRORS as exc:
            logger.warning("KBManager.list_docs failed: %s", exc)
            return []
        return out

    def upload(self, key: str, data: bytes) -> dict:
        try:
            self._s3.put_object(Bucket=self._bucket, Key=key, Body=data)
        except _AWS_ERRORS as exc:
            logger.warning("KBManager.upload failed for %s: %s", key, exc)
            return {"ok": False, "error": _safe_error(exc)}
        return {"ok": True}

    def delete(self, key: str) -> dict:
        try:
            self._s3.delete_object(Bucket=self._bucket, Key=key)
        except _AWS_ERRORS as exc:
            logger.warning("KBManager.delete failed for %s: %s", key, exc)
            return {"ok": False, "error": _safe_error(exc)}
        return {"ok": True}

    def start_ingestion(self) -> dict:
        try:
            resp = self._agent.start_ingestion_job(
                knowledgeBaseId=self._kb_id, dataSourceId=self._ds
            )
        except _AWS_ERRORS as exc:
            logger.warning("KBManager.start_ingestion failed: %s", exc)
            return {"ok": False, "error": _safe_error(exc)}
        return {"ok": True, "job_id": resp["ingestionJob"]["ingestionJobId"]}

    def latest_job_status(self) -> dict:
        try:
            resp = self._agent.list_ingestion_jobs(
                knowledgeBaseId=self._kb_id,
                dataSourceId=self._ds,
                maxResults=1,
                sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
            )
        except _AWS_ERRORS as exc:
            logger.warning("KBManager.latest_job_status failed: %s", exc)
            return {"status": "ERROR", "error": _safe_error(exc)}
        jobs = resp.get("ingestionJobSummaries", [])
        if not jobs:
            return {"status": "NONE"}
        job = jobs[0]
        return {"job_id": job["ingestionJobId"], "status": job["status"]}
