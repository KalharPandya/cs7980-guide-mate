# 3D model assets

All binary assets in this directory (and `world-client/public/textures/`) are CC0 /
public domain and were downloaded by `world/scripts/fetch_assets.sh`. That script is
safe to re-run: it skips any asset that already exists and is a valid glTF binary,
so a second run is a no-op.

To re-fetch (or fetch for the first time on a fresh checkout):

```bash
world/scripts/fetch_assets.sh
```

## Assets

### `robot.glb`
- Source: three.js example asset "RobotExpressive", fetched from
  `https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/RobotExpressive.glb`
- Author: Don McCurdy (contributed to the three.js examples repo)
- License: CC0 (public domain)
- Verified: 463,988 bytes, starts with the glTF binary magic (`glTF`), embeds 14
  animation clips (`Dance`, `Death`, `Idle`, `Jump`, `No`, `Punch`, `Running`,
  `Sitting`, `Standing`, `ThumbsUp`, `Walking`, `WalkJump`, `Wave`, `Yes`).

### `visitor.glb`
- Source: Quaternius CC0 human model, distributed via poly.pizza. Model page:
  `https://poly.pizza/m/c3Ibh9I3udk`; direct file:
  `https://static.poly.pizza/170235d2-cdeb-4cb2-a82f-4828585138fe.glb`
- Author: Quaternius (quaternius.com)
- License: CC0 (public domain)
- Verified: 698,560 bytes, starts with the glTF binary magic (`glTF`), embeds 8
  animation clips (`ArmatureAction.002`, `Death`, `Idle`, `Jump`, `Punch`, `Run`,
  `Walk`, `Working`) — includes the `Idle` and `Walk` clips this project needs.

### `furniture/*.glb`
- Source: Kenney Furniture Kit, fetched from the versioned zip URL scraped off
  `https://kenney.nl/assets/furniture-kit` (the direct .zip URL embeds a version
  hash that rotates, so the fetch script scrapes the current href each run).
- Author: Kenney (www.kenney.nl)
- License: CC0 (public domain) — see `furniture/LICENSE.txt`, copied verbatim from
  the zip, which confirms "License: (Creative Commons Zero, CC0)".
- Contents: 140 `.glb` model files (one per furniture/prop piece: chairs, desks,
  sofas, kitchen appliances, plants, etc.), ~2.2 MB total. The zip also ships
  FBX/OBJ/DAE/STL versions of every model plus isometric/side preview PNGs;
  the fetch script keeps only the `.glb` files to save repo space.

## Attribution

- **Kenney** (kenney.nl) — Furniture Kit, CC0. Credit is not mandatory under CC0
  but is given here per Kenney's request.
- **Quaternius** (quaternius.com) / poly.pizza — human visitor model, CC0.
- **three.js / Don McCurdy** — RobotExpressive robot model, CC0.
