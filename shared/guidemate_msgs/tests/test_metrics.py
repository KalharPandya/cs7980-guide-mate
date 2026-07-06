import json

from guidemate_msgs.metrics import NAMESPACE, emit_metric


def test_emit_metric_emf_structure(capsys):
    payload = emit_metric(
        "AckRoundTripMs", 123.4, "Milliseconds", {"robot_id": "turtlebot468"}
    )
    line = capsys.readouterr().out.strip().splitlines()[-1]
    data = json.loads(line)
    assert data["AckRoundTripMs"] == 123.4
    assert data["robot_id"] == "turtlebot468"
    meta = data["_aws"]["CloudWatchMetrics"][0]
    assert meta["Namespace"] == NAMESPACE
    assert meta["Dimensions"] == [["robot_id"]]
    assert meta["Metrics"][0] == {"Name": "AckRoundTripMs", "Unit": "Milliseconds"}
    assert isinstance(data["_aws"]["Timestamp"], int)
    assert payload["AckRoundTripMs"] == 123.4


def test_emit_metric_no_dimensions(capsys):
    emit_metric("TurnLatencyMs", 50.0, "Milliseconds")
    data = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert data["_aws"]["CloudWatchMetrics"][0]["Dimensions"] == [[]]
    assert data["TurnLatencyMs"] == 50.0


def test_emit_metric_stringifies_dimension_values(capsys):
    emit_metric("X", 1, dimensions={"robot_id": 468})
    data = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert data["robot_id"] == "468"  # dimension values are always strings for CW
