# Bellhop avatar v2 (more precise model), source files

Generated with Tripo, 47.5k triangles, PBR textures. Same style as v1 (`../bellhop_rigged.glb`,
used by the app as `web/public/avatar/bellhop.glb`).

- `fbx/bellhop_v2.fbx` + `fbx/bellhop_v2.fbm/` (textures): **unrigged**, start here to rig.
- `obj/`: unrigged OBJ + MTL + PBR textures.
- `bellhop_v2_tripo_rig_broken.glb`: Tripo's auto-rig output. **Do not use as is**: it has a
  Mixamo-named skeleton (53 joints, LeftHandRing2 and the *4 finger tips missing) but every
  vertex is skinned 100% to `mixamorig:Hips`, so arms and fingers do not deform.

To do (Nath): rig v2 with full finger bones (3 phalanges per finger, Mixamo names so
`web/lib/avatar/bellhop.ts` keeps working), export a GLB and swap it in
`web/public/avatar/bellhop.glb` once it plays as well as v1.
