"""L0a network-origin gate: only clients egressing from the campus network
(NUwave) may reach visitor-facing routes. Companion to the L0b rotating-QR
check-in (admission_demo); design + rollout runbook:
docs/agent-poc/nuwave-origin-gate.md.

Ships dark. Modes (GUIDEMATE_ORIGIN_MODE):
  - "off"     (default) middleware is a pass-through; zero behavior change.
  - "log"     never blocks; logs every request that WOULD be blocked. Use this
              to run the on-campus egress-IP measurements.
  - "enforce" non-allowlisted clients get 403 (HTTP) / close 4403 (WebSocket).

GUIDEMATE_ORIGIN_ALLOWLIST: comma-separated CIDRs. The default is the measured
Vancouver campus egress block (208.98.212.96/29, ARIN NORTHEASTERN-UNIVERSITY;
NUwave and NUwave-guest both NAT out of it — measurement log in the runbook,
2026-07-22). Boston's 155.33/16 + 129.10/16 are deliberately NOT included: the
product is scoped to the Vancouver campus, which also means NEU-VPN
(GlobalProtect) clients egressing from Boston space are blocked by design.
Still confirm in "log" mode before anyone flips "enforce"; see the runbook.
Invalid entries are logged and skipped; enforcing with an empty allowlist
fails CLOSED (every non-exempt request is blocked).

GUIDEMATE_ORIGIN_EXEMPT: comma-separated path prefixes that bypass the gate.
Defaults cover the deploy probes (/healthz, /readyz) and the admin surface
(/admin static UI + /api/admin API), which has its own cookie auth and must
stay reachable for the team working off campus.

Trust model (important): exactly one proxy — Caddy — fronts this app in
production (agent_service/Caddyfile). Caddy v2.5+ ignores X-Forwarded-For from
untrusted clients and appends the address it actually saw, so the LAST entry
of X-Forwarded-For is the only trustworthy one. Never read the first entry:
it is attacker-controlled. Without the header (direct/dev access) the gate
falls back to the ASGI peer address.
"""
from __future__ import annotations

import ipaddress
import logging
import os
from typing import Optional, Union

log = logging.getLogger(__name__)

IPAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]

# The Vancouver campus egress /29 (measured 2026-07-22: NUwave and NUwave-guest
# share it; Boston ranges intentionally excluded — Vancouver-scoped product).
# See the measurement log in docs/agent-poc/nuwave-origin-gate.md.
DEFAULT_ALLOWLIST = "208.98.212.96/29"
DEFAULT_EXEMPT = "/healthz,/readyz,/admin,/api/admin"

_BLOCK_BODY = (
    b'{"error":"NOT_ON_CAMPUS","detail":"This service is available from the '
    b'Northeastern campus network (NUwave) only."}'
)


class OriginGate:
    """Pure ASGI middleware (covers both HTTP and WebSocket scopes)."""

    def __init__(
        self,
        app,
        mode: Optional[str] = None,
        allowlist: Optional[str] = None,
        exempt: Optional[str] = None,
    ) -> None:
        self.app = app
        self.mode = (mode or os.environ.get("GUIDEMATE_ORIGIN_MODE", "off")).strip().lower()
        if self.mode not in ("off", "log", "enforce"):
            log.error("origin-gate: unknown mode %r -> treating as 'off'", self.mode)
            self.mode = "off"

        raw = (
            allowlist
            if allowlist is not None
            else os.environ.get("GUIDEMATE_ORIGIN_ALLOWLIST", DEFAULT_ALLOWLIST)
        )
        self.networks = []
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                self.networks.append(ipaddress.ip_network(part))
            except ValueError:
                log.error("origin-gate: invalid CIDR %r ignored", part)
        if self.mode == "enforce" and not self.networks:
            # Fail closed, loudly: a security control with a broken config must
            # not silently become a no-op.
            log.error(
                "origin-gate: enforce mode with an EMPTY allowlist — failing closed, "
                "ALL non-exempt requests will be blocked"
            )

        exempt_raw = (
            exempt if exempt is not None else os.environ.get("GUIDEMATE_ORIGIN_EXEMPT", DEFAULT_EXEMPT)
        )
        self.exempt = tuple(p.strip() for p in exempt_raw.split(",") if p.strip())
        if self.mode != "off":
            log.info(
                "origin-gate: mode=%s allowlist=%s exempt=%s",
                self.mode,
                [str(n) for n in self.networks],
                list(self.exempt),
            )

    async def __call__(self, scope, receive, send) -> None:
        if self.mode == "off" or scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if any(path.startswith(prefix) for prefix in self.exempt):
            await self.app(scope, receive, send)
            return

        client_ip = self._client_ip(scope)
        if client_ip is not None and any(client_ip in net for net in self.networks):
            await self.app(scope, receive, send)
            return

        if self.mode == "log":
            log.warning(
                "origin-gate[log]: would block %s %s from %s",
                scope["type"],
                path,
                client_ip,
            )
            await self.app(scope, receive, send)
            return

        log.info("origin-gate: blocked %s %s from %s", scope["type"], path, client_ip)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": _BLOCK_BODY})

    @staticmethod
    def _client_ip(scope) -> Optional[IPAddress]:
        """The client address as established by the trusted proxy (see module doc).

        Last X-Forwarded-For entry (appended by Caddy) wins; a malformed value
        parses to None, which the caller treats as not-allowlisted.
        """
        headers = dict(scope.get("headers") or [])
        xff = headers.get(b"x-forwarded-for")
        if xff:
            last = xff.decode("latin-1").split(",")[-1].strip()
            try:
                return ipaddress.ip_address(last)
            except ValueError:
                return None
        client = scope.get("client")
        if client:
            try:
                return ipaddress.ip_address(client[0])
            except ValueError:
                return None  # e.g. starlette's TestClient peer "testclient"
        return None
