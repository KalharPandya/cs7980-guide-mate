import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Bakes an entire (possibly multi-mesh, possibly skinned) glTF scene graph into ONE static,
 * non-skinned BufferGeometry, standing upright with feet at y=0 and scaled so its tallest point
 * sits at `targetHeightMeters`. Used to turn RobotExpressive.glb (Task 0.4's CC0 robot asset)
 * into a single draw call for drei's <Instances>/<Instance> (see Robot.tsx) -- per Task 3.2's
 * brief, robots are "rigid enough to batch": they never need a per-instance skeletal pose, only
 * a per-instance position/rotation, so freezing the whole rig into one static mesh is exactly
 * the right trade (real GPU instancing) instead of animating dozens of individual skeletons.
 *
 * MUST be called on a scene graph that has never had an AnimationMixer/clip applied to it (right
 * after GLTFLoader/useGLTF parses the asset) -- this bakes whatever pose the scene is CURRENTLY
 * in, which for a freshly parsed glTF is its authored bind/rest pose.
 *
 * How the skin-bake is derived (not a guess -- read from three.js's own SkinnedMesh source,
 * then checked against ground truth before this was ever wired into a React component):
 * `Mesh.prototype.getVertexPosition(index, target)` returns the raw authored vertex position for
 * a plain Mesh; `SkinnedMesh.prototype.getVertexPosition` overrides it to additionally apply
 * `applyBoneTransform`, which composes `bindMatrix` (the mesh's own matrixWorld at bind time) +
 * each weighted bone's `matrixWorld * boneInverse` + `bindMatrixInverse`, and returns the result
 * in the SkinnedMesh's own LOCAL space (the same space `mesh.matrixWorld` transforms FROM). So
 * calling `getVertexPosition` on every mesh in the scene (skinned or not) and then applying that
 * mesh's own `matrixWorld` reconstructs the correct world-space bind pose uniformly, with no
 * special-casing needed between the model's 13 rigid parts and its 2 truly-skinned parts
 * (RobotExpressive's hands). Verified offline (Node prototype, not shipped) against
 * `new THREE.Box3().setFromObject(scene, true)` (drei/three's own "precise", skin-aware bbox):
 * worst-case per-axis difference was ~1e-7 (float noise), i.e. exact, not approximate.
 *
 * Normals are recomputed post-bake (`computeVertexNormals`) rather than hand-transformed --
 * simpler, and just as correct for a single frozen pose.
 */
export function bakeToStandingGeometry(
  root: THREE.Object3D,
  targetHeightMeters: number,
): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
  root.updateMatrixWorld(true)

  const meshes: THREE.Mesh[] = []
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh)
  })
  if (meshes.length === 0) {
    throw new Error('bakeToStandingGeometry: no meshes found in scene graph')
  }

  const vertex = new THREE.Vector3()
  const bakedGeometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []

  for (const mesh of meshes) {
    const positionAttr = mesh.geometry.attributes.position
    const count = positionAttr.count
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, vertex)
      positions[i * 3] = vertex.x
      positions[i * 3 + 1] = vertex.y
      positions[i * 3 + 2] = vertex.z
    }

    const baked = new THREE.BufferGeometry()
    baked.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    if (mesh.geometry.index) baked.setIndex(mesh.geometry.index.clone())
    baked.applyMatrix4(mesh.matrixWorld)
    baked.computeVertexNormals()

    bakedGeometries.push(baked)
    materials.push(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)
  }

  const merged = mergeGeometries(bakedGeometries, true)
  if (!merged) {
    throw new Error('bakeToStandingGeometry: mergeGeometries failed -- mismatched attributes across meshes')
  }

  // Scale to targetHeightMeters, then stand it on the floor (feet at y=0). Order matters:
  // BufferGeometry.scale()/translate() mutate the attribute buffer in place immediately, so the
  // bounding box must be recomputed between the two steps -- scaling changes min.y.
  merged.computeBoundingBox()
  const nativeHeight = merged.boundingBox!.max.y - merged.boundingBox!.min.y
  const scale = targetHeightMeters / nativeHeight
  merged.scale(scale, scale, scale)

  merged.computeBoundingBox()
  merged.translate(0, -merged.boundingBox!.min.y, 0)
  merged.computeBoundingBox()

  return { geometry: merged, materials }
}
