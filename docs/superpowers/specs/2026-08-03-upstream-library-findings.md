# Upstream library findings (2026-08-02/03)

Three genuine bugs in third-party dependencies, found while hardening the virtual-world guide
fleet. All three were reproduced against the pinned installed versions with direct evidence, not
inferred from behaviour.

**Status: NOT reported upstream.** Filing public issues is Kalhar's call, not something a Claude
session should do autonomously. This document exists so that the evidence is not lost and so
filing is a five-minute job if he wants to. Two of the three are worth reporting; the third is
arguably not (see its own section).

Local workarounds are already in place for all three, so nothing here is blocking.

---

## 1. `@colyseus/schema` 4.0.30: `Root.remove()` leaks a `refCount` entry per removed ref

**Severity for us: was real.** Drove unbounded memory growth in a long-running room.

`Root.remove()` (`node_modules/@colyseus/schema/build/index.mjs`, around line 4161-4206) sets a
removed ref's `refCount` entry to zero but never `delete`s the key. So every schema instance that
is ever added and removed leaves a permanent entry behind.

In our case `WorldRoom` spawned a fresh `new Agent()` per simulated visitor, ~45 of them cycling
continuously (spawn, escort, dwell, walk back, despawn) for the life of the process. Every one
left a dangling entry.

**Evidence:** directly observable as the `root.refCount` key count climbing monotonically with
spawn count, measured in `world/scripts/soaktest.ts`. After our workaround the same metric is
flat: 184 `addAgent` calls resolved to 67 distinct refIds with a `root.refCount` delta of **0**
(see `world/scripts/pooltest.ts`).

**Our workaround:** pool and reuse `Agent` schema instances instead of constructing new ones, so
after the pool warms to peak concurrent agent count, `new Agent()` is never called again.
(`world/src/rooms/WorldRoom.ts`'s `agentPool`.)

---

## 2. `@colyseus/schema` 4.0.30: `MapSchema` index allocation is never reclaimed when zero clients are connected

**Severity for us: real, and specifically nasty because it only fires when nobody is watching.**

`MapSchema#set()` allocates a fresh internal index for any key string it has not seen before.
That index is reclaimed by `$onEncodeEnd()` — but `SchemaSerializer#applyPatches()` skips
`$onEncodeEnd()` entirely when there are **no connected clients**.

So a room that keeps simulating while unobserved accumulates map indexes forever. This is exactly
the state our world-server sits in by design: it was made to persist independently of viewers
(`autoDispose = false`) precisely so the authoritative simulation keeps running whether or not the
big screen is connected. The fix for one problem activated the other.

**Evidence:** `MapSchema.indexes` key count growing without bound across spawn/despawn cycles with
zero clients attached; flat after the workaround (192/192/96 keys stable over a 10,000-simulated-
second run, versus unbounded growth before).

**Our workaround:** recycle a bounded set of visitor id strings rather than minting a unique id per
spawn, so the set of distinct keys the map ever sees is bounded.
(`world/src/rooms/simulatedVisitorSpawner.ts`'s `freeSlotIds`.)

**Why this is worth reporting:** the zero-clients path is easy to miss in testing (most Colyseus
rooms have at least one client by construction, and `autoDispose` defaults to true so a room with
no clients usually does not exist for long). Anyone running a persistent authoritative simulation
hits this.

---

## 3. `@react-three/drei` `useAnimations`: cleanup calls `uncacheAction` with the wrong argument type

**Severity for us: none. Reporting is optional and low-value — see below.**

`useAnimations`' unmount cleanup (`node_modules/@react-three/drei/core/useAnimations.js`) calls:

```js
mixer.uncacheAction(action, currentRoot)
```

passing an `AnimationAction`. three.js's `AnimationMixer#uncacheAction(clip, root)`
(`node_modules/three/src/animation/AnimationMixer.js`) expects an `AnimationClip`. `AnimationAction`
has no `.uuid`, so `existingAction()` cannot resolve it and the call is a **silent no-op** — no
error, no warning.

**Evidence (empirical, against `three@0.185.1`):** after the drei-style call,
`mixer.stats.actions.total` / `.bindings.total` remained at `2` / `34`. Calling it correctly with
the clip dropped both to `0` / `0`.

**Why we did not fix it locally and why reporting is optional:** it does not leak. Once React drops
its reference on unmount, nothing outside the component retains the mixer, so the whole
clone/mixer/actions/bindings subgraph becomes unreachable and is collected as a unit. GC cares
about reachability, not about whether an internal cache was tidied first. Our client-side soak
measured **1.8% heap growth over 6000 clone/mixer/unmount cycles**, with a deliberate-retention
control run in the same harness showing 316% growth to prove the measurement had signal
(`world-client/src/scene/__tests__/visitorLifecycleSoak.test.ts`).

It would matter for a consumer who keeps a mixer alive across many `useAnimations` mounts against
the same root, where the untrimmed bookkeeping would accumulate on a still-reachable mixer. That is
a plausible enough usage to be worth a drive-by issue, but it is not our bug and not urgent.

---

## If reporting these

Each section above has the file path, the approximate location, the mechanism, and reproducible
evidence at the pinned version. Worth checking the projects' current `main` first — all three were
found against the versions this repo pins (`@colyseus/schema` 4.0.30, `three` 0.185.1, and drei as
pinned in `world-client/package.json`), and any of them may already be fixed upstream.

Do not file anything containing this project's private details; all three reduce to small
self-contained reproductions that need nothing from this repo.
