import fs from "node:fs";
// Rigs the v2 bellhop mesh with the working v1 skeleton (Mixamo names, 65 joints) by transferring v1's skin weights.
//   node assets/avatar/v2/transfer_skin.mjs <out.glb>        (from the repo root, after `npm install` in web/)
// 1. ICP-fits v1's hands, then each finger, onto v2 (v2's hands sit ~35 mm closer to the elbow), swings the forearms.
// 2. Moves v1's joints with those fits, deforms v1 the same way (forearm also shortened, for the transfer only).
// 3. Each v2 vertex takes the weights of the closest same-facing point on the deformed v1 surface (barycentric).
// 4. Patches cut off from the rest of their bone are refilled from their neighbours.
// Output: v2 mesh, material and textures (from the Tripo GLB, same mesh as obj/) with the new skeleton and weights.
const THREE = await import(new URL("../../../web/node_modules/three/build/three.module.js", import.meta.url).href);
function readGlb(path) {
  const buf = fs.readFileSync(path);
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8"));
  const binLen = buf.readUInt32LE(20 + jl);
  const bin = Buffer.from(buf.subarray(20 + jl + 8, 20 + jl + 8 + binLen));
  const read = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const stride = bv.byteStride ? bv.byteStride / C.BYTES_PER_ELEMENT : n;
    const raw = new C(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), (a.count - 1) * stride + n);
    const out = new Float32Array(a.count * n);
    const norm = a.normalized ? (C === Uint8Array ? 255 : C === Uint16Array ? 65535 : 1) : 1;
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = raw[k * stride + c] / norm;
    return out;
  };
  // world matrices of all nodes
  const { Matrix4, Vector3, Quaternion } = THREE;
  const local = json.nodes.map((n) => n.matrix ? new Matrix4().fromArray(n.matrix)
    : new Matrix4().compose(new Vector3().fromArray(n.translation ?? [0, 0, 0]), new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(n.scale ?? [1, 1, 1])));
  const parent = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
  const world = local.map(() => null);
  const getWorld = (i) => world[i] ?? (world[i] = parent[i] < 0 ? local[i].clone() : getWorld(parent[i]).clone().multiply(local[i]));
  json.nodes.forEach((_, i) => getWorld(i));
  const prim = json.meshes[0].primitives[0];
  return { json, bin, read, local, world, parent, prim };
}
// Uniform grid over points for nearest queries.
function grid(points, cell) {
  const map = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < points.length / 3; i++) { const k = key(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]); (map.get(k) ?? map.set(k, []).get(k)).push(i); }
  return { cell, map, near(x, y, z, r) { const out = []; const cr = Math.ceil(r / cell); const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    for (let a = -cr; a <= cr; a++) for (let b = -cr; b <= cr; b++) for (let c = -cr; c <= cr; c++) { const l = map.get(`${cx + a},${cy + b},${cz + c}`); if (l) out.push(...l); } return out; } };
}
const { Matrix4, Vector3, Quaternion } = THREE;
const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node assets/avatar/v2/transfer_skin.mjs <out.glb>");

const v1 = readGlb("assets/avatar/bellhop_rigged.glb");
const v2 = readGlb("assets/avatar/v2/bellhop_v2_tripo_rig_broken.glb");
const P1 = v1.read(v1.prim.attributes.POSITION), N1 = v1.read(v1.prim.attributes.NORMAL);
const J1 = v1.read(v1.prim.attributes.JOINTS_0), W1 = v1.read(v1.prim.attributes.WEIGHTS_0);
const I1 = v1.read(v1.prim.indices);
const P2 = v2.read(v2.prim.attributes.POSITION), N2 = v2.read(v2.prim.attributes.NORMAL);
const I2 = v2.read(v2.prim.indices);
const n1 = P1.length / 3, n2 = P2.length / 3;
const skinJoints = v1.json.skins[0].joints; // node indices
const jname = skinJoints.map((j) => v1.json.nodes[j].name.replace("mixamorig:", ""));
const jidx = Object.fromEntries(jname.map((n, k) => [n, k]));
const jointWorld = skinJoints.map((j) => v1.world[j].clone());
const jointPos = jointWorld.map((m) => new Vector3().setFromMatrixPosition(m));
const dominant = new Int32Array(n1);
for (let i = 0; i < n1; i++) { let b = 0; for (let k = 1; k < 4; k++) if (W1[i * 4 + k] > W1[i * 4 + b]) b = k; dominant[i] = J1[i * 4 + b]; }
const v = (A, i) => new Vector3(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]);

// ---------- ICP (point-to-point, Horn's quaternion method) ----------
const g2 = grid(P2, 0.01);
function horn(src, dst) {
  const ca = new Vector3(), cb = new Vector3();
  src.forEach((a) => ca.add(a)); dst.forEach((b) => cb.add(b)); ca.divideScalar(src.length); cb.divideScalar(dst.length);
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < src.length; i++) {
    const ax = src[i].x - ca.x, ay = src[i].y - ca.y, az = src[i].z - ca.z, bx = dst[i].x - cb.x, by = dst[i].y - cb.y, bz = dst[i].z - cb.z;
    Sxx += ax * bx; Sxy += ax * by; Sxz += ax * bz; Syx += ay * bx; Syy += ay * by; Syz += ay * bz; Szx += az * bx; Szy += az * by; Szz += az * bz;
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const c = N.flat().reduce((s, x) => s + Math.abs(x), 0) + 1e-9;
  let q = [1, 0, 0, 0];
  for (let it = 0; it < 200; it++) {
    const r = [0, 1, 2, 3].map((i) => N[i].reduce((s, x, j) => s + x * q[j], 0) + c * q[i]);
    const len = Math.hypot(...r); q = r.map((x) => x / len);
  }
  const rot = new Quaternion(q[1], q[2], q[3], q[0]).normalize();
  const t = cb.clone().sub(ca.clone().applyQuaternion(rot));
  return new Matrix4().compose(t, rot, new Vector3(1, 1, 1));
}
function icp(indices, init, label) {
  let T = init.clone();
  const nm = new Matrix4();
  let last = Infinity;
  for (let it = 0; it < 60; it++) {
    nm.extractRotation(T);
    const src = [], dst = [], dists = [];
    for (const i of indices) {
      const a = v(P1, i).applyMatrix4(T), na = v(N1, i).applyMatrix4(nm);
      let best = -1, bd = Infinity;
      for (const j of g2.near(a.x, a.y, a.z, 0.04)) {
        if (na.x * N2[j * 3] + na.y * N2[j * 3 + 1] + na.z * N2[j * 3 + 2] < 0.3) continue;
        const d = Math.hypot(P2[j * 3] - a.x, P2[j * 3 + 1] - a.y, P2[j * 3 + 2] - a.z);
        if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) { src.push(a); dst.push(v(P2, best)); dists.push(bd); }
    }
    const med = [...dists].sort((x, y) => x - y)[Math.floor(dists.length / 2)] ?? 0;
    const keep = dists.map((d) => d <= Math.max(2.5 * med, 0.002));
    const s = src.filter((_, k) => keep[k]), d = dst.filter((_, k) => keep[k]);
    if (s.length < 10) break;
    T = horn(s, d).multiply(T);
    if (Math.abs(last - med) < 1e-6) break;
    last = med;
  }
  console.log(`  ICP ${label.padEnd(16)} pts ${String(indices.length).padStart(4)}  median residual ${(last * 1000).toFixed(1)} mm`);
  return T;
}
const deltaOf = (T) => { const p = new Vector3(), q = new Quaternion(), s = new Vector3(); T.decompose(p, q, s); return { deg: (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI }; };

// ---------- per-joint alignment transforms ----------
const jointT = jointWorld.map(() => new Matrix4()); // identity unless fitted (rigid: moves the joints)
const deformT = new Map(); // joint -> non-rigid override used only to deform v1 for the transfer
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
for (const side of ["Left", "Right"]) {
  console.log(side);
  const handJoints = new Set(jname.map((n, k) => (n.startsWith(`${side}Hand`) ? k : -1)).filter((k) => k >= 0));
  const handVerts = [...Array(n1).keys()].filter((i) => handJoints.has(dominant[i]));
  const Thand = icp(handVerts, new Matrix4(), `${side} hand`);
  jointT[jidx[`${side}Hand`]] = Thand;
  for (const f of FINGERS) {
    const fj = [1, 2, 3, 4].map((k) => jidx[`${side}Hand${f}${k}`]);
    const verts = [...Array(n1).keys()].filter((i) => fj.includes(dominant[i]));
    let Tf = icp(verts, Thand, `${side} ${f}`);
    const rel = deltaOf(Thand.clone().invert().multiply(Tf));
    if (rel.deg > 30) { console.log(`   ${f}: finger fit turned ${rel.deg.toFixed(0)} deg away from the hand, using the hand fit`); Tf = Thand; }
    for (const k of fj) jointT[k] = Tf;
  }
  // Forearm: swing about the elbow so it ends at the moved wrist.
  const E = jointPos[jidx[`${side}ForeArm`]], W = jointPos[jidx[`${side}Hand`]];
  const W2 = W.clone().applyMatrix4(Thand);
  const swing = new Quaternion().setFromUnitVectors(W.clone().sub(E).normalize(), W2.clone().sub(E).normalize());
  jointT[jidx[`${side}ForeArm`]] = new Matrix4().makeTranslation(E.x, E.y, E.z).multiply(new Matrix4().makeRotationFromQuaternion(swing)).multiply(new Matrix4().makeTranslation(-E.x, -E.y, -E.z));
  // For the transfer only: also shorten v1's forearm along its axis to v2's length.
  const axis = W2.clone().sub(E).normalize(), k = W2.distanceTo(E) / W.distanceTo(E);
  const squash = new Matrix4().set(
    1 + (k - 1) * axis.x * axis.x, (k - 1) * axis.x * axis.y, (k - 1) * axis.x * axis.z, 0,
    (k - 1) * axis.y * axis.x, 1 + (k - 1) * axis.y * axis.y, (k - 1) * axis.y * axis.z, 0,
    (k - 1) * axis.z * axis.x, (k - 1) * axis.z * axis.y, 1 + (k - 1) * axis.z * axis.z, 0,
    0, 0, 0, 1);
  deformT.set(jidx[`${side}ForeArm`], new Matrix4().makeTranslation(E.x, E.y, E.z).multiply(squash).multiply(new Matrix4().makeTranslation(-E.x, -E.y, -E.z)).multiply(jointT[jidx[`${side}ForeArm`]]));
  console.log(`  wrist moved ${(W2.distanceTo(W) * 1000).toFixed(1)} mm, forearm length ${(W.distanceTo(E) * 1000).toFixed(1)} -> ${(W2.distanceTo(E) * 1000).toFixed(1)} mm`);
}

// ---------- deform v1 with the fits (linear blend skinning), then residuals per region ----------
const P1d = new Float32Array(P1.length), N1d = new Float32Array(N1.length);
for (let i = 0; i < n1; i++) {
  const p = v(P1, i), n = v(N1, i), acc = new Vector3(), accN = new Vector3();
  for (let k = 0; k < 4; k++) {
    const w = W1[i * 4 + k]; if (!w) continue;
    const T = deformT.get(J1[i * 4 + k]) ?? jointT[J1[i * 4 + k]];
    acc.addScaledVector(p.clone().applyMatrix4(T), w);
    accN.addScaledVector(n.clone().applyMatrix4(new Matrix4().extractRotation(T)), w);
  }
  P1d.set([acc.x, acc.y, acc.z], i * 3); accN.normalize(); N1d.set([accN.x, accN.y, accN.z], i * 3);
}

// ---------- transfer: closest point on the deformed v1 surface, barycentric weights ----------
const tris1 = I1.length / 3;
const triGrid = new Map(); const CELL = 0.01;
for (let t = 0; t < tris1; t++) {
  const ids = [I1[t * 3], I1[t * 3 + 1], I1[t * 3 + 2]];
  const lo = [0, 1, 2].map((c) => Math.floor(Math.min(...ids.map((i) => P1d[i * 3 + c])) / CELL));
  const hi = [0, 1, 2].map((c) => Math.floor(Math.max(...ids.map((i) => P1d[i * 3 + c])) / CELL));
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = `${x},${y},${z}`; (triGrid.get(k) ?? triGrid.set(k, []).get(k)).push(t); }
}
const triangle = new THREE.Triangle(), closest = new Vector3(), bary = new Vector3(), faceN = new Vector3();
const J2 = new Uint8Array(n2 * 4), W2 = new Float32Array(n2 * 4);
let fallback = 0; const dist2 = new Float32Array(n2);
for (let i = 0; i < n2; i++) {
  const p = v(P2, i), n = v(N2, i);
  let best = null, bestD = Infinity, any = null, anyD = Infinity;
  for (let r = 1; r <= 8 && best === null; r *= 2) {
    const c = [p.x, p.y, p.z].map((x) => Math.floor(x / CELL)); const seen = new Set();
    for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++) for (const t of triGrid.get(`${c[0] + x},${c[1] + y},${c[2] + z}`) ?? []) {
      if (seen.has(t)) continue; seen.add(t);
      const a = v(P1d, I1[t * 3]), b = v(P1d, I1[t * 3 + 1]), cc = v(P1d, I1[t * 3 + 2]);
      triangle.set(a, b, cc); triangle.closestPointToPoint(p, closest); const d = closest.distanceTo(p);
      triangle.getNormal(faceN);
      if (d < anyD) { anyD = d; any = t; }
      if (faceN.dot(n) > 0.2 && d < bestD) { bestD = d; best = t; }
    }
    if (best !== null && bestD > r * CELL) best = null, bestD = Infinity; // a closer one may sit in the next ring
  }
  const t = best ?? any; if (best === null) fallback++;
  dist2[i] = best !== null ? bestD : anyD;
  const a = v(P1d, I1[t * 3]), b = v(P1d, I1[t * 3 + 1]), cc = v(P1d, I1[t * 3 + 2]);
  triangle.set(a, b, cc); triangle.closestPointToPoint(p, closest); triangle.getBarycoord(closest, bary);
  const acc = new Map();
  [bary.x, bary.y, bary.z].forEach((bw, corner) => { const vi = I1[t * 3 + corner]; for (let k = 0; k < 4; k++) { const w = W1[vi * 4 + k] * bw; if (w > 0) acc.set(J1[vi * 4 + k], (acc.get(J1[vi * 4 + k]) ?? 0) + w); } });
  const top = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4); const sum = top.reduce((s, x) => s + x[1], 0);
  top.forEach(([j, w], k) => { J2[i * 4 + k] = j; W2[i * 4 + k] = w / sum; });
}
const q = (a, t) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(t * (s.length - 1))]; };
console.log(`transfer: v2 vertex -> deformed v1 surface p50 ${(q(dist2, .5) * 1000).toFixed(1)} mm, p95 ${(q(dist2, .95) * 1000).toFixed(1)} mm, max ${(Math.max(...dist2) * 1000).toFixed(1)} mm; ${fallback} vertices without a same-facing match`);

// ---------- islands: patches whose dominant bone is cut off from the rest of that bone ----------
const key = (i) => `${P2[i * 3].toFixed(5)},${P2[i * 3 + 1].toFixed(5)},${P2[i * 3 + 2].toFixed(5)}`;
const weld = new Map(), uid = new Int32Array(n2);
for (let i = 0; i < n2; i++) { const k = key(i); if (!weld.has(k)) weld.set(k, weld.size); uid[i] = weld.get(k); }
const nu = weld.size, rep = new Int32Array(nu); for (let i = 0; i < n2; i++) rep[uid[i]] = i;
const adj = Array.from({ length: nu }, () => new Set());
for (let t = 0; t < I2.length / 3; t++) { const a = uid[I2[t * 3]], b = uid[I2[t * 3 + 1]], c = uid[I2[t * 3 + 2]]; adj[a].add(b).add(c); adj[b].add(a).add(c); adj[c].add(a).add(b); }
const dom2 = (u) => J2[rep[u] * 4]; // top weight first
const comps = new Map(); const seenU = new Int8Array(nu);
for (let u = 0; u < nu; u++) {
  if (seenU[u]) continue; const j = dom2(u), comp = [u]; seenU[u] = 1;
  for (let h = 0; h < comp.length; h++) for (const w of adj[comp[h]]) if (!seenU[w] && dom2(w) === j) { seenU[w] = 1; comp.push(w); }
  (comps.get(j) ?? comps.set(j, []).get(j)).push(comp);
}
const island = new Int8Array(nu); let islandCount = 0;
for (const [, list] of comps) { const big = Math.max(...list.map((c) => c.length)); for (const c of list) if (c.length < big && c.length < 0.25 * big) { c.forEach((u) => (island[u] = 1)); islandCount += c.length; } }
const wU = Array.from({ length: nu }, (_, u) => { const m = new Map(); for (let k = 0; k < 4; k++) if (W2[rep[u] * 4 + k] > 0) m.set(J2[rep[u] * 4 + k], W2[rep[u] * 4 + k]); return m; });
let pending = [...Array(nu).keys()].filter((u) => island[u]);
while (pending.length) {
  const next = [];
  const updates = [];
  for (const u of pending) {
    const src = [...adj[u]].filter((w) => !island[w]);
    if (!src.length) { next.push(u); continue; }
    const m = new Map(); for (const w of src) for (const [j, x] of wU[w]) m.set(j, (m.get(j) ?? 0) + x / src.length);
    updates.push([u, m]);
  }
  if (!updates.length) break;
  for (const [u, m] of updates) { wU[u] = m; island[u] = 0; }
  pending = next;
}
for (let i = 0; i < n2; i++) {
  const top = [...wU[uid[i]].entries()].sort((x, y) => y[1] - x[1]).slice(0, 4); const sum = top.reduce((s, x) => s + x[1], 0);
  for (let k = 0; k < 4; k++) { J2[i * 4 + k] = top[k]?.[0] ?? 0; W2[i * 4 + k] = top[k] ? top[k][1] / sum : 0; }
}
console.log(`islands: ${islandCount} welded vertices reassigned from their neighbours (of ${nu})`);

// ---------- new skeleton: v1 joints moved by their fits ----------
const newWorld = jointWorld.map((m, k) => jointT[k].clone().multiply(m));
const parentJoint = skinJoints.map((j) => skinJoints.indexOf(v1.parent[j]));
const nodesOut = [];
const v2nodes = v2.json.nodes; // 0 Armature, 1 mesh node, 2.. old joints
const armature = { ...v2nodes[0], children: [1] }, meshNode = { ...v2nodes[1] };
nodesOut.push(armature, meshNode);
const base = nodesOut.length;
skinJoints.forEach((j, k) => {
  const local = parentJoint[k] < 0 ? newWorld[k].clone() : newWorld[parentJoint[k]].clone().invert().multiply(newWorld[k]);
  const t = new Vector3(), r = new Quaternion(), s = new Vector3(); local.decompose(t, r, s);
  nodesOut.push({ name: v1.json.nodes[j].name, translation: t.toArray(), rotation: r.toArray() });
});
skinJoints.forEach((j, k) => { if (parentJoint[k] < 0) armature.children.push(base + k); else (nodesOut[base + parentJoint[k]].children ??= []).push(base + k); });

// ---------- write GLB: v2 mesh/material/textures, new joints, IBMs, JOINTS_0, WEIGHTS_0 ----------
const json = structuredClone(v2.json);
json.nodes = nodesOut;
json.scenes[json.scene ?? 0].nodes = [0];
let bin = Buffer.from(v2.bin);
const append = (bytes, extra) => {
  const pad = (4 - (bin.length % 4)) % 4; if (pad) bin = Buffer.concat([bin, Buffer.alloc(pad)]);
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: bytes.length, ...extra });
  bin = Buffer.concat([bin, bytes]);
  return json.bufferViews.length - 1;
};
const ibm = new Float32Array(skinJoints.length * 16);
newWorld.forEach((m, k) => ibm.set(m.clone().invert().elements, k * 16));
json.accessors.push({ bufferView: append(Buffer.from(ibm.buffer)), componentType: 5126, count: skinJoints.length, type: "MAT4" });
json.skins = [{ joints: skinJoints.map((_, k) => base + k), inverseBindMatrices: json.accessors.length - 1 }];
json.nodes[1].skin = 0;
json.accessors.push({ bufferView: append(Buffer.from(J2.buffer), { target: 34962 }), componentType: 5121, count: n2, type: "VEC4" });
const prim = json.meshes[0].primitives[0];
prim.attributes.JOINTS_0 = json.accessors.length - 1;
json.accessors.push({ bufferView: append(Buffer.from(W2.buffer), { target: 34962 }), componentType: 5126, count: n2, type: "VEC4" });
prim.attributes.WEIGHTS_0 = json.accessors.length - 1;
json.buffers = [{ byteLength: bin.length }];
json.asset = { version: "2.0", generator: "CamelHack v1->v2 skin transfer (Tripo mesh)" };
let jsonBuf = Buffer.from(JSON.stringify(json)); jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPad.length, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
fs.writeFileSync(OUT, Buffer.concat([header, ch(jsonBuf.length, 0x4e4f534a), jsonBuf, ch(binPad.length, 0x004e4942), binPad]));
console.log("wrote", OUT, (fs.statSync(OUT).size / 1e6).toFixed(2), "MB,", json.skins[0].joints.length, "joints");
