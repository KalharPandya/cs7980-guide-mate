#!/usr/bin/env python3
"""
Tests for maps.py (pgm->png conversion + S3 key helpers).

Run:  cd <repo>/scripts && python -m pytest test_maps.py -v
      (or python scripts/test_maps.py from the repo root)
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import maps as m  # noqa: E402

from PIL import Image  # noqa: E402


class TestKeyHelpers(unittest.TestCase):
    def test_bucket_name(self):
        self.assertEqual(m.MAPS_BUCKET, "guidemate-maps-852373397000")

    def test_map_key(self):
        self.assertEqual(m.map_key("turtlebot468"), "maps/turtlebot468/latest.png")

    def test_meta_key(self):
        self.assertEqual(m.meta_key("turtlebot468"), "maps/turtlebot468/meta.json")


class TestPgmToPng(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            pgm = os.path.join(tmp, "map.pgm")
            png = os.path.join(tmp, "latest.png")
            # A tiny grayscale occupancy grid saved as binary PGM (P5).
            Image.new("L", (6, 4), color=205).save(pgm)  # 205 = "unknown" in SLAM maps
            m.pgm_to_png(pgm, png)
            self.assertTrue(os.path.exists(png))
            self.assertGreater(os.path.getsize(png), 0)
            with Image.open(png) as out:
                self.assertEqual(out.format, "PNG")
                self.assertEqual(out.size, (6, 4))
                self.assertEqual(out.mode, "L")

    def test_roundtrip_nonuniform(self):
        with tempfile.TemporaryDirectory() as tmp:
            pgm = os.path.join(tmp, "map2.pgm")
            png = os.path.join(tmp, "latest2.png")
            im = Image.new("L", (4, 4))
            pixels = [0, 205, 254, 0, 205, 254, 0, 205, 254, 0, 205, 254, 0, 205, 254, 0]
            im.putdata(pixels)
            im.save(pgm)
            m.pgm_to_png(pgm, png)
            with Image.open(png) as out:
                self.assertEqual(list(out.getdata()), pixels)


class TestFetchHelpers(unittest.TestCase):
    """Pure round-trip against a fake boto3 s3 client (no network)."""

    class FakeBody:
        def __init__(self, data: bytes):
            self._data = data

        def read(self):
            return self._data

    class FakeS3:
        def __init__(self, objects):
            self.objects = objects
            self.calls = []

        def get_object(self, Bucket, Key):  # noqa: N803
            self.calls.append((Bucket, Key))
            return {"Body": TestFetchHelpers.FakeBody(self.objects[(Bucket, Key)])}

    def test_fetch_map_png(self):
        key = m.map_key("turtlebot468")
        fake = self.FakeS3({(m.MAPS_BUCKET, key): b"\x89PNGfakebytes"})
        data = m.fetch_map_png(fake, "turtlebot468")
        self.assertEqual(data, b"\x89PNGfakebytes")
        self.assertEqual(fake.calls, [(m.MAPS_BUCKET, key)])

    def test_fetch_map_meta(self):
        key = m.meta_key("turtlebot468")
        fake = self.FakeS3(
            {(m.MAPS_BUCKET, key): b'{"captured_ts": "2026-07-05T00:00:00+00:00", "source": "/home/ubuntu/map.pgm"}'}
        )
        meta = m.fetch_map_meta(fake, "turtlebot468")
        self.assertEqual(meta["captured_ts"], "2026-07-05T00:00:00+00:00")
        self.assertEqual(meta["source"], "/home/ubuntu/map.pgm")


if __name__ == "__main__":
    unittest.main()
