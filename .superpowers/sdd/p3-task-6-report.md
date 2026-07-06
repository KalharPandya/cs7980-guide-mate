# P3 Task 6 report — Admin UI + app wiring + fake robot hook

## Status: COMPLETE. 80 passed, 4 skipped.

## Files
- NEW `agent_service/guidemate_agent/fakes.py` — `FakeRobotRegistry`.
- NEW `agent_service/static/admin/{index.html,admin.js,admin.css}`.
- MOD `agent_service/guidemate_agent/app.py` — fake-robot hook in lifespan + `StaticFiles` mount at `/admin`.
- MOD `agent_service/tests/test_app.py` — appended two wiring tests.

## Approach
TDD: appended the two brief tests, confirmed they fail (ModuleNotFoundError fakes / 404 /admin/),
implemented, then green. Read the merged `admin.py` / `store.py` / `kb.py` / `mqtt_link.py` /
`config.py` / `dog_agent.py` / `messages.py` and wired the UI to the ACTUAL route shapes.

## UI → endpoint wiring (all verified via TestClient over https base_url)
- login → `POST /api/admin/login {password}` → `{ok:true}`; 429 + 503 handled.
- flag toggle → `PUT /flags {name,value}` immediately; reverts checkbox on failure.
- prompt save → `PUT /prompt {system_prompt}` (empty textarea sent as `null`); clear → `{system_prompt:null}`.
- robot tab → `GET /status` → `{robots:[...]}`; cards show presence dot, battery %, dock state, gates; kill button → `POST /kill-switch {robot_id}` with confirm().
- KB tab → `GET /kb` `{docs:[{key,size,modified}]}`; delete → `DELETE /kb?key=`; upload → `POST /kb` multipart `file`; sync → `POST /kb/sync` then polls `GET /kb/sync-status` `{status}`.

## Adaptations (merged reality won over the brief's verbatim code)
1. **DogAgent takes NO `kb_id`** — the merged `DogAgent.__init__(registry, model_id, robot_ids, region, store)` has no `kb_id` param. The brief's app.py passed `kb_id=cfg.kb_id` and would have raised TypeError. Kept the existing `DogAgent(..., store=store)` call unchanged.
2. **app.py minimally edited, not rewritten** — it was already router-wired with ConfigStore/KBManager/Config. Only added the `GUIDEMATE_FAKE_ROBOT` branch + the `/admin` StaticFiles mount (per brief "IF NOT already present").
3. **`credentials: 'same-origin'`** in `admin.js` (task instruction) instead of the brief's `'include'`.
4. **Enriched fake `get_status`** with `docked`/`gates`/`last_heartbeat` (beyond the brief's minimal dict) so the Robot tab renders battery/dock/gates identically against the fake. Test assertions (robot_id/presence/acks) still hold.
5. **UI extras** for a non-ugly, usable panel: dark-mode CSS via `prefers-color-scheme`, robot status cards, KB size shown in KB, sync-status polling loop, delete/upload confirm + failure alerts, flag revert-on-error.
6. **Test hygiene**: the reload test restores `GUIDEMATE_FAKE_ROBOT`/`GUIDEMATE_ADMIN_PASSWORD` and reloads `app` in a `finally` so it can't leak the fake registry into other tests.

## Concerns
- Authenticated admin routes require a Secure cookie → only exercised over `https://` (TestClient/localhost is a secure context). The route test only asserts 401-without-cookie + page-serves, which is bus-context-independent. Documented in the brief already.
- `GET /flags` in smoke reached real DynamoDB defaults (AWS creds present); degrades to defaults offline.

## Untouched (per instructions): admin.py, kb.py, store.py, dog_agent.py.
