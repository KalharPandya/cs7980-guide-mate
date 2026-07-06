"""S3 map storage helpers + local PGM->PNG conversion for the admin Maps tab.

Standalone module (Phase-6 Task 4 scope). Deliberately kept OUT of
agent_service: the admin Maps tab endpoint (Phase-6 Task 5) owns wiring
`fetch_map_png`/`fetch_map_meta` into the FastAPI app and may re-home or
re-import this module at that point. `scripts/upload_map_from_pi.sh` is the
only current consumer (via PYTHONPATH=scripts).
"""
from __future__ import annotations

import json

MAPS_BUCKET = "guidemate-maps-852373397000"


def map_key(robot_id: str) -> str:
    return f"maps/{robot_id}/latest.png"


def meta_key(robot_id: str) -> str:
    return f"maps/{robot_id}/meta.json"


def pgm_to_png(pgm_path: str, png_path: str) -> None:
    """Convert a SLAM occupancy-grid .pgm to an 8-bit grayscale PNG."""
    from PIL import Image

    with Image.open(pgm_path) as im:
        im.convert("L").save(png_path, format="PNG")


def fetch_map_png(s3_client, robot_id: str) -> bytes:
    """Read the latest map PNG bytes from S3 (raises the boto3 error if absent)."""
    obj = s3_client.get_object(Bucket=MAPS_BUCKET, Key=map_key(robot_id))
    return obj["Body"].read()


def fetch_map_meta(s3_client, robot_id: str) -> dict:
    """Read the latest map meta.json from S3 (raises the boto3 error if absent)."""
    obj = s3_client.get_object(Bucket=MAPS_BUCKET, Key=meta_key(robot_id))
    return json.loads(obj["Body"].read())
