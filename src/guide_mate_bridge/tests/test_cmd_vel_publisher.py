from guidemate_msgs.choreography import TwistStep

from guide_mate_bridge.cmd_vel_publisher import CmdVelPublisher


class _Vec:
    def __init__(self):
        self.x = self.y = self.z = 0.0


class FakeTwist:
    def __init__(self):
        self.linear = _Vec()
        self.angular = _Vec()


class FakePub:
    def __init__(self):
        self.msgs = []

    def publish(self, msg):
        self.msgs.append(msg)


class FakeNode:
    def __init__(self):
        self.pub = FakePub()
        self.created = None

    def create_publisher(self, msg_type, topic, depth):
        self.created = (msg_type, topic, depth)
        return self.pub


def test_publishes_twist_with_vx_and_wz():
    node = FakeNode()
    pub = CmdVelPublisher(node, topic="/cmd_vel", twist_cls=FakeTwist)
    assert node.created == (FakeTwist, "/cmd_vel", 10)
    pub(TwistStep(0.12, 0.24, 5.0))
    assert len(node.pub.msgs) == 1
    msg = node.pub.msgs[0]
    assert msg.linear.x == 0.12
    assert msg.angular.z == 0.24
    assert msg.linear.y == 0.0 and msg.linear.z == 0.0
