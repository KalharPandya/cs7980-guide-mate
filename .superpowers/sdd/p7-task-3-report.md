# P7 Task 3 report — Dockerfile + Compose (app+caddy) + prod overlay

**Status:** DONE, real build + verify GREEN (`/healthz` → `{"ok":true}` through Caddy on :80).

## Files delivered (agent_service/)
- `Dockerfile` — python:3.12-slim; installs `shared/guidemate_msgs` then `agent_service`; `EXPOSE 8000`; `/healthz` HEALTHCHECK; runs `uvicorn guidemate_agent.app:app`.
- `.dockerignore` — verbatim per brief.
- `Caddyfile` — `{$GUIDEMATE_DOMAIN} { reverse_proxy app:8000 }`.
- `compose.yaml` — `app` (build context `..`) + `caddy` (:80/:443), `caddy_data` volume.
- `compose.prod.yaml` — awslogs logging overlay for both services.

## Deviation from the verbatim brief (ONE line, in Dockerfile only)
The brief's `RUN pip install /app/agent_service` alone produces a **crash-looping image**.
Root cause (upstream, not my files): the app resolves its UI assets via
`STATIC_DIR = Path(__file__).parent.parent / "static"` (agent_service/guidemate_agent/app.py:25),
i.e. a `static/` dir that is a *sibling* of the package. A non-editable `pip install` ships
only the `guidemate_agent` package (pyproject `packages.find` includes only `guidemate_agent*`),
so at runtime `site-packages/static/admin` does not exist and app import fails:
`RuntimeError: Directory '.../site-packages/static/admin' does not exist` → Caddy returns 502.

Fix (kept strictly inside my only editable code file, honoring the non-editable prod install):
```dockerfile
RUN cp -r /app/agent_service/static "$(python -c 'import site; print(site.getsitepackages()[0])')/static"
```
This places `static/` where the app resolves it. Python-version-agnostic (no hardcoded path).

**Recommended proper home for this fix (out of my scope):** Task 2's
`agent_service/pyproject.toml` should ship `static/` as package data (or the app should load
it via `importlib.resources`). If the controller relocates the fix there, this Dockerfile line
can be dropped. Flagging so it isn't lost.

## Real build + verify evidence
- `sudo docker build -f agent_service/Dockerfile -t guidemate-agent:local .` → `Successfully tagged guidemate-agent:local` (Step 11/11).
- `GUIDEMATE_DOMAIN=http://localhost sudo -E docker compose up -d --build` with throwaway env
  (`GUIDEMATE_FAKE_ROBOT=1`, `GUIDEMATE_ADMIN_PASSWORD=test`, `GUIDEMATE_IOT_ENDPOINT=dummy.example.com`; **no AWS creds mounted**).
- `curl -i http://localhost/healthz` (through Caddy :80):
  ```
  HTTP/1.1 200 OK
  Content-Type: application/json
  Server: uvicorn
  Via: 1.1 Caddy
  {"ok":true}
  ```
  `Via: 1.1 Caddy` + upstream `Server: uvicorn` confirm the full Caddy → app:8000 proxy path.
- App container HEALTHCHECK reached `health=healthy`.
- `docker compose -f compose.yaml -f compose.prod.yaml config` merges cleanly → both services
  get `logging.driver: awslogs` with the expected groups.

## Cleanup
`docker compose down -v` (containers + `caddy_data` volume removed) + `docker rmi
guidemate-agent:local agent_service-app` + `image prune -f` (47.6 MB reclaimed).
Verified: NO remaining guidemate/agent_service images or containers. Documented tag that was
built: `guidemate-agent:local`.

## Concerns
1. The static-packaging gap above — real bug that would break any `pip install`-based image;
   ideally fixed in Task 2's pyproject rather than papered over in the Dockerfile.
2. Verify used the legacy Docker builder (BuildKit not the default here); `# syntax=` directive
   is harmless/ignored by the legacy builder. Behavior identical for this Dockerfile.

## Fix: `.dockerignore` was a no-op (review finding, 2026-07-05)
**Root cause:** `compose.yaml` builds with `context: ..` (repo root), but `.dockerignore`
lived at `agent_service/.dockerignore`. Docker only honors a `.dockerignore` at the
**context root**, so the file was silently ignored — every build shipped the *entire* repo
root to the daemon, including `ssh_keys/agent_ed25519` (private key, when present at the
main checkout) and any `.claude/worktrees/` content (hundreds of MB there).

**Fix:**
- `git mv agent_service/.dockerignore .dockerignore` (now at the build context root).
- Extended the pattern list (root-relative), keeping all prior entries and adding:
  `tests/`, `**/tests/`, `.claude/`, `ssh_keys/`, `docs/`, `.superpowers/`, `src/`, `.git/`,
  plus `claude-conversations/`, `Research/`, `rviz/` (discovered empirically — see below;
  none of these are read by the Dockerfile, which only `COPY`s `shared/guidemate_msgs` and
  `agent_service`, the latter including `static/`).
- Verified the Dockerfile's two `COPY` instructions only touch `shared/guidemate_msgs` and
  `agent_service` (which contains `static/`) — confirms `src/`, `docs/`, etc. are safe to
  exclude and `agent_service/static` is never excluded.

**Empirical verification** (legacy builder, same as the original review):
`cd <worktree> && sudo docker build -f agent_service/Dockerfile -t guidemate-agent:ignoretest .`
- Before the extra excludes (root `.dockerignore` present but missing
  `claude-conversations/`/`Research/`): `Sending build context to Docker daemon 23.77MB` —
  dominated by `claude-conversations/` (21MB, tracked conversation-session logs, not needed
  by the image).
- After adding `claude-conversations/`, `Research/`, `rviz/`: **`Sending build context to
  Docker daemon 183.3kB`.**
- This worktree has no `ssh_keys/` or `.claude/worktrees/` of its own (linked worktree —
  only tracked/local files present), so the ~365MB/private-key scenario from the review
  couldn't be reproduced here directly; confirmed instead that the new root-level
  `.dockerignore` is honored at all (context dropped from what would otherwise be the
  full 25MB `du -sh .` of this worktree to 183.3kB) and that the added patterns
  (`.claude/`, `ssh_keys/`, `.git/`, `src/`, `docs/`) cover the paths named in the finding.
- Build completed to `Successfully tagged guidemate-agent:ignoretest`.
- Verified image still ships UI assets:
  `docker run --rm guidemate-agent:ignoretest python -c "..."` → lists
  `/usr/local/lib/python3.12/site-packages/static -> ['index.html', 'admin']`. Confirms
  `.dockerignore` does not exclude `agent_service/static`.
- Cleanup: `docker rmi guidemate-agent:ignoretest` + `docker image prune -f`. No leftover
  test images/containers.
