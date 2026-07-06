#!/usr/bin/env python3
"""Idempotently create the 4 on-demand DynamoDB tables for the dog agent POC.

Tables (all PAY_PER_REQUEST, tagged project=guidemate-poc):
  guidemate-sessions   pk: session_id
  guidemate-messages   pk: session_id, sk: ts
  guidemate-requests   pk: request_id
  guidemate-config     pk: pk           (flags + admin-set prompt; used from Phase 3)

Re-running is safe: an already-existing table is left untouched.
Run: python3 scripts/create_dynamo_tables.py
"""
from __future__ import annotations

import os

import boto3
from botocore.exceptions import ClientError

TAGS = [{"Key": "project", "Value": "guidemate-poc"}]


def table_specs() -> list:
    return [
        {
            "TableName": "guidemate-sessions",
            "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}],
            "AttributeDefinitions": [
                {"AttributeName": "session_id", "AttributeType": "S"}
            ],
        },
        {
            "TableName": "guidemate-messages",
            "KeySchema": [
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "ts", "KeyType": "RANGE"},
            ],
            "AttributeDefinitions": [
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "ts", "AttributeType": "S"},
            ],
        },
        {
            "TableName": "guidemate-requests",
            "KeySchema": [{"AttributeName": "request_id", "KeyType": "HASH"}],
            "AttributeDefinitions": [
                {"AttributeName": "request_id", "AttributeType": "S"}
            ],
        },
        {
            "TableName": "guidemate-config",
            "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}],
            "AttributeDefinitions": [{"AttributeName": "pk", "AttributeType": "S"}],
        },
    ]


def main() -> None:
    region = os.environ.get("AWS_REGION", "us-west-2")
    client = boto3.client("dynamodb", region_name=region)
    existing = set(client.list_tables().get("TableNames", []))
    for spec in table_specs():
        name = spec["TableName"]
        if name in existing:
            print(f"exists, skipping: {name}")
            continue
        try:
            client.create_table(
                BillingMode="PAY_PER_REQUEST",
                Tags=TAGS,
                **spec,
            )
            print(f"created: {name} (PAY_PER_REQUEST, tagged guidemate-poc)")
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ResourceInUseException":
                print(f"race, already exists: {name}")
            else:
                raise


if __name__ == "__main__":
    main()
