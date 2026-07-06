import os
import pytest


def pytest_collection_modifyitems(config, items):
    run_integration = os.environ.get("GUIDEMATE_INTEGRATION") == "1"
    run_live = os.environ.get("GUIDEMATE_LIVE") == "1"
    skip_integration = pytest.mark.skip(reason="set GUIDEMATE_INTEGRATION=1 to run")
    skip_live = pytest.mark.skip(reason="set GUIDEMATE_LIVE=1 to run")
    for item in items:
        if "integration" in item.keywords and not run_integration:
            item.add_marker(skip_integration)
        if "live" in item.keywords and not run_live:
            item.add_marker(skip_live)
