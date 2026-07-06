"""AWS IoT MQTT client wrapper (mTLS). Connection object is injectable for tests."""
from __future__ import annotations

import json
import logging
from typing import Callable, Optional

from awscrt import mqtt
from awsiot import mqtt_connection_builder

from guidemate_msgs.messages import status_topic

log = logging.getLogger(__name__)


class IotClient:
    def __init__(
        self,
        endpoint: str,
        cert_filepath: str,
        pri_key_filepath: str,
        client_id: str,
        robot_id: str,
        ca_filepath: Optional[str] = None,
        connection=None,
    ) -> None:
        self._robot_id = robot_id
        self._status_topic = status_topic(robot_id)
        if connection is not None:
            self._conn = connection
            return
        will = mqtt.Will(
            topic=self._status_topic,
            qos=mqtt.QoS.AT_LEAST_ONCE,
            payload=json.dumps({"event": "offline", "robot_id": robot_id}).encode("utf-8"),
            retain=False,
        )
        kwargs = dict(
            endpoint=endpoint,
            cert_filepath=cert_filepath,
            pri_key_filepath=pri_key_filepath,
            client_id=client_id,
            clean_session=False,
            keep_alive_secs=30,
            will=will,
        )
        if ca_filepath:
            kwargs["ca_filepath"] = ca_filepath
        self._conn = mqtt_connection_builder.mtls_from_path(**kwargs)

    def connect(self) -> None:
        self._conn.connect().result()
        self.publish(
            self._status_topic,
            json.dumps({"event": "online", "robot_id": self._robot_id}),
        )

    def subscribe(self, topic: str, callback: Callable[[str, str], None]) -> None:
        def _on_message(topic, payload, dup, qos, retain, **kwargs):
            callback(topic, payload.decode("utf-8"))

        future, _ = self._conn.subscribe(
            topic=topic, qos=mqtt.QoS.AT_LEAST_ONCE, callback=_on_message
        )
        future.result()

    def publish(self, topic: str, payload_str: str) -> None:
        future, _ = self._conn.publish(
            topic=topic,
            payload=payload_str.encode("utf-8"),
            qos=mqtt.QoS.AT_LEAST_ONCE,
        )

        # Non-blocking delivery check. NEVER call future.result() here: publish() is
        # invoked from awscrt callback threads (e.g. the shadow delta handler), and
        # blocking the event loop on its own puback would deadlock the connection.
        def _warn_on_failure(f) -> None:
            try:
                f.result()
            except Exception as exc:  # noqa: BLE001
                log.warning("publish to %s failed: %s", topic, exc)

        future.add_done_callback(_warn_on_failure)

    def disconnect(self) -> None:
        try:
            self._conn.disconnect().result()
        except Exception as exc:  # noqa: BLE001
            log.warning("disconnect failed: %s", exc)
