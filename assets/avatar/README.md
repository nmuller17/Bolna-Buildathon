# Bellhop avatar, source files

Generated with Tripo (image-to-3D), auto-rigged by Tripo with a Mixamo-compatible 65-joint skeleton.
The app now uses the v2 model (`v2/`, see its README) as `web/public/avatar/bellhop.glb`.
This v1 stays as the fallback: copy `bellhop_rigged.glb` over `web/public/avatar/bellhop.glb` to go back.

- `bellhop_rigged.glb`: v1, rigged, 48.8k triangles, textures embedded.
- `obj/`: unrigged mesh (OBJ + MTL) with PBR textures.
- `fbx/`: unrigged FBX, textures in `bellhop.fbm/` (rename back to match the FBX if a tool cannot find them).
