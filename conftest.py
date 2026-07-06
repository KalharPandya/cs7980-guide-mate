import os
import pytest


def pytest_collection_modifyitems(config, items):
    run_integration = os.environ.get("GUIDEMATE_INTEGRATION") == "1"
    run_live = os.environ.get("GUIDEMATE_LIVE") == "1"
    run_e2e = os.environ.get("GUIDEMATE_E2E") == "1"
    skip_integration = pytest.mark.skip(reason="set GUIDEMATE_INTEGRATION=1 to run")
    skip_live = pytest.mark.skip(reason="set GUIDEMATE_LIVE=1 to run")
    skip_e2e = pytest.mark.skip(reason="set GUIDEMATE_E2E=1 to run")
    for item in items:
        if "integration" in item.keywords and not run_integration:
            item.add_marker(skip_integration)
        if "live" in item.keywords and not run_live:
            item.add_marker(skip_live)
        if "e2e" in item.keywords and not run_e2e:
            item.add_marker(skip_e2e)
