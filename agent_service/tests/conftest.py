import importlib.util
import sys
from pathlib import Path

# Make scripts/create_dynamo_tables.py importable as `scripts_create_dynamo_tables`.
_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "create_dynamo_tables.py"
_spec = importlib.util.spec_from_file_location("scripts_create_dynamo_tables", _SCRIPT)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["scripts_create_dynamo_tables"] = _mod
_spec.loader.exec_module(_mod)
