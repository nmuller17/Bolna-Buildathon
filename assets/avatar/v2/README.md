# Bellhop avatar v2 (more precise model), source files

Generated with Tripo, 47.5k triangles, PBR textures. Same style as v1 (`../bellhop_rigged.glb`, kept as fallback).

**Used by the app** as `web/public/avatar/bellhop.glb`: v2 mesh rigged with v1's skeleton (65 joints, Mixamo names,
3 phalanges + tip per finger), made by `transfer_skin.mjs`. Checked in /avatar-preview with HELLO, A B C L V Y,
"FS:ID SHOW PLEASE", "YOUR ROOM 4 1 2": plays at least as well as v1.

- `transfer_skin.mjs`: rebuilds that GLB: `node assets/avatar/v2/transfer_skin.mjs web/public/avatar/bellhop.glb`
  (from the repo root, after `npm install` in `web/`). It fits v1's hands and fingers onto v2 (v2's hands sit
  ~35 mm closer to the elbow), moves v1's joints with them, and copies v1's skin weights from the closest point.
- `fbx/bellhop_v2.fbx` + `fbx/bellhop_v2.fbm/` (textures): unrigged.
- `obj/`: unrigged OBJ + MTL + PBR textures (same mesh as the GLBs).
- `bellhop_v2_tripo_rig_broken.glb`: Tripo's auto-rig output, only its mesh and textures are reused by
  `transfer_skin.mjs`. Do not use its rig: 53 joints all at the origin, LeftHandRing2 and the *4 finger tips
  missing, every vertex skinned 100% to `mixamorig:Hips`.
