"""CloudWatch Embedded Metric Format (EMF) helper.

Metrics are just log lines. Print an EMF JSON blob to stdout; the Docker
`awslogs` driver (service) or `aws logs put-log-events` (Pi log-ship) delivers
it to CloudWatch Logs, which auto-extracts the embedded metric. Zero metrics
infrastructure, no PutMetricData throttling.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Optional

NAMESPACE = "GuideMate"


def emit_metric(
    name: str,
    value: float,
    unit: str = "Count",
    dimensions: Optional[dict] = None,
    namespace: str = NAMESPACE,
) -> dict:
    dims = {key: str(val) for key, val in (dimensions or {}).items()}
    dim_keys = list(dims.keys())
    payload = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": namespace,
                    "Dimensions": [dim_keys],
                    "Metrics": [{"Name": name, "Unit": unit}],
                }
            ],
        },
        name: value,
    }
    payload.update(dims)
    # Telemetry is best-effort and must NEVER crash the caller: a request turn,
    # ack round-trip, or heartbeat must not fail because stdout is closed/broken
    # or the payload can't serialize. Swallow and continue.
    try:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()
    except Exception:
        pass
    return payload
