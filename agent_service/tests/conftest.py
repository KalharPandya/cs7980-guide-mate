import importlib.util
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

# Make scripts/create_dynamo_tables.py importable as `scripts_create_dynamo_tables`.
_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "create_dynamo_tables.py"
_spec = importlib.util.spec_from_file_location("scripts_create_dynamo_tables", _SCRIPT)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["scripts_create_dynamo_tables"] = _mod
_spec.loader.exec_module(_mod)


@pytest.fixture
def ddb(monkeypatch):
    """Start moto, create the four guidemate tables, yield the dynamodb resource.

    The table key schemas MIRROR the real Phase 3 tables (scripts/
    create_dynamo_tables.py): guidemate-messages RANGE key is ``ts`` and
    guidemate-config partition key is ``pk``. (The Phase 4 brief drafted these
    as ``sk``/``key``; corrected here so the offline moto tests exercise the
    same schema the code hits against the deployed tables.)

    Env creds are forced to dummies so botocore never touches the real
    credential_process while mocked (env creds outrank the shared-config profile).
    """
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    with mock_aws():
        res = boto3.resource("dynamodb", region_name="us-west-2")
        res.create_table(
            TableName="guidemate-sessions",
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        res.create_table(
            TableName="guidemate-messages",
            KeySchema=[
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "ts", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "ts", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        res.create_table(
            TableName="guidemate-requests",
            KeySchema=[{"AttributeName": "request_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "request_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        res.create_table(
            TableName="guidemate-config",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield res
