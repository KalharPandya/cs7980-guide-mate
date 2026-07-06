from guide_mate_bridge.dock_actions import DockActions


class FakeFuture:
    def __init__(self, result_value):
        self._result = result_value

    def done(self):
        return True

    def result(self):
        return self._result


class FakeGoalHandle:
    def __init__(self, accepted=True):
        self.accepted = accepted

    def get_result_async(self):
        return FakeFuture(object())


class FakeActionClient:
    def __init__(self, server_up=True, accepted=True):
        self.server_up = server_up
        self.accepted = accepted
        self.sent = 0

    def wait_for_server(self, timeout_sec=None):
        return self.server_up

    def send_goal_async(self, goal):
        self.sent += 1
        return FakeFuture(FakeGoalHandle(accepted=self.accepted))


class FakeGoalCls:
    class Goal:
        pass


def _actions(undock=None, dock=None):
    clients = {"undock": undock or FakeActionClient(), "dock": dock or FakeActionClient()}

    def factory(name):
        return clients[name], FakeGoalCls

    return DockActions(node=None, client_factory=factory), clients


def test_undock_success_sends_one_goal():
    actions, clients = _actions()
    ok, reason = actions.run("undock")
    assert ok and reason == ""
    assert clients["undock"].sent == 1
    assert clients["dock"].sent == 0


def test_dock_success():
    actions, clients = _actions()
    ok, _ = actions.run("dock")
    assert ok
    assert clients["dock"].sent == 1


def test_server_unavailable_fails():
    actions, _ = _actions(dock=FakeActionClient(server_up=False))
    ok, reason = actions.run("dock")
    assert not ok and "unavailable" in reason


def test_goal_rejected_fails():
    actions, _ = _actions(undock=FakeActionClient(accepted=False))
    ok, reason = actions.run("undock")
    assert not ok and "rejected" in reason


def test_unknown_action_name_fails():
    actions, _ = _actions()
    ok, reason = actions.run("teleport")
    assert not ok and "unknown" in reason
