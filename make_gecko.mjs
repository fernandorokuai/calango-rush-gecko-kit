// Makes model.glb for a Calango Rush gecko: the base gecko painted in the entity's colours, plus an optional
// accessory model under a node named "accessory".
//   node make_gecko.mjs entity.json [accessory.glb] [out/model.glb]
// The game paints its own runner from entity.json and takes only the "accessory" node from model.glb;
// the whole model is what the player's profile shows.
import fs from 'node:fs'
import path from 'node:path'
import jpeg from 'jpeg-js'
import { Document, NodeIO } from '@gltf-transform/core'

const [entityFile, accessoryFile, outFile = 'model.glb'] = process.argv.slice(2)
if (!entityFile) { console.log('usage: node make_gecko.mjs entity.json [accessory.glb] [out/model.glb]'); process.exit(1) }
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
const e = JSON.parse(fs.readFileSync(entityFile, 'utf8'))
for (const k of ['helmet', 'body', 'belly']) if (!/^#[0-9a-fA-F]{6}$/.test(e[k] || '')) throw new Error(`entity.json needs ${k} as #rrggbb`)
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
const [HELMET, BODY, BELLY] = [e.helmet, e.body, e.belly].map(h => rgb(h).map(toLinear))

const io = new NodeIO()
const doc = await io.read(path.join(HERE, 'base', 'gecko_base.glb'))
const root = doc.getRoot(), buf = root.listBuffers()[0]
const prim = root.listMeshes()[0].listPrimitives()[0]
const baseTex = prim.getMaterial().getBaseColorTexture()
const img = jpeg.decode(baseTex.getImage(), { useTArray: true })
const W = img.width, H = img.height, src = img.data

// the same recolouring the game's shader does, per texel; `mode` is 'helmet' or 'skin'
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
// a small blur of brightness, so painted-in seams fade like the game's mip lookup
const bright = new Float32Array(W * H)
for (let i = 0; i < W * H; i++) bright[i] = Math.max(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]) / 255
const blur = new Float32Array(W * H), R = 3
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let s = 0, n = 0
  for (let dy = -R; dy <= R; dy += 1) for (let dx = -R; dx <= R; dx += 2) { const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)); s += bright[yy * W + xx]; n++ }
  blur[y * W + x] = s / n
}
function paint(mode) {
  const out = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const c = [0, 1, 2].map(k => toLinear(src[i * 4 + k] / 255))
    const m0 = Math.max(...c), n0 = Math.min(...c), dd = m0 - n0, sat = m0 > 0 ? dd / m0 : 0
    let hue = 0
    if (dd > 0) hue = m0 === c[1] ? 60 * ((c[2] - c[0]) / dd + 2) : m0 === c[0] ? 60 * (((c[1] - c[2]) / dd) % 6 + 6) % 360 : 60 * ((c[0] - c[1]) / dd + 4)
    const mx = (m0 + toLinear(blur[i])) / 2
    let r = c
    if (mode === 'helmet') {
      const k = ss(0.12, 0.26, sat) * (1 - ss(200, 220, hue)) * ss(0.04, 0.1, m0)
      r = c.map((v, j) => v + (HELMET[j] * (0.25 + mx * 0.95) - v) * k)
    } else {
      const lilac = ss(190, 210, hue) * (1 - ss(0.35, 0.5, sat))
      const orange = (1 - ss(30, 40, hue)) * ss(0.45, 0.6, sat)
      const whites = ss(0.82, 0.9, m0) * (1 - ss(0.15, 0.3, sat))
      const k = ss(0.04, 0.1, m0) * (1 - Math.max(lilac, orange, whites))
      const yel = 1 - ss(56, 70, hue < 200 ? hue : 0)
      r = c.map((v, j) => { const body = BODY[j] * (0.18 + mx * 1.15), belly = BELLY[j] * (0.3 + mx * 1.1); return v + (body + (belly - body) * yel - v) * k })
    }
    for (let j = 0; j < 3; j++) out[i * 4 + j] = Math.round(Math.min(1, Math.max(0, toSrgb(r[j]))) * 255)
    out[i * 4 + 3] = 255
  }
  return jpeg.encode({ data: out, width: W, height: H }, 82).data
}

// split the triangles: the helmet shell gets the helmet paint, everything else the skin paint
const P = prim.getAttribute('POSITION').getArray(), N = prim.getAttribute('NORMAL').getArray(), UV = prim.getAttribute('TEXCOORD_0').getArray()
const Hm = prim.getAttribute('_HELMET').getArray(), I = prim.getIndices().getArray()
const parts = { helmet: [], skin: [] }
for (let t = 0; t < I.length; t += 3) parts[(Hm[I[t]] + Hm[I[t + 1]] + Hm[I[t + 2]]) / 3 > 0.5 ? 'helmet' : 'skin'].push(I[t], I[t + 1], I[t + 2])
const mesh = root.listMeshes()[0]
prim.dispose()
const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf)
// both parts share one set of vertex data
const shared = { POSITION: acc('VEC3', new Float32Array(P)), NORMAL: acc('VEC3', new Float32Array(N)), TEXCOORD_0: acc('VEC2', new Float32Array(UV)) }
for (const [mode, idx] of Object.entries(parts)) {
  const tex = doc.createTexture(mode).setImage(new Uint8Array(paint(mode))).setMimeType('image/jpeg')
  const mat = doc.createMaterial(mode === 'helmet' ? 'Helmet' : 'Skin').setBaseColorTexture(tex).setRoughnessFactor(mode === 'helmet' ? 0.35 : 0.6).setMetallicFactor(0)
  mesh.addPrimitive(doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', shared.POSITION).setAttribute('NORMAL', shared.NORMAL)
    .setAttribute('TEXCOORD_0', shared.TEXCOORD_0).setIndices(acc('SCALAR', new Uint16Array(idx))))
}
for (const t of root.listTextures()) if (t === baseTex) t.dispose()
for (const m of root.listMaterials()) if (!m.getBaseColorTexture()) m.dispose()

// the accessory: every mesh of accessory.glb, kept as is, under one node named "accessory"
let accTris = 0
if (accessoryFile) {
  const a = await io.read(accessoryFile)
  const holder = doc.createNode('accessory')
  root.listScenes()[0].addChild(holder)
  const copy = new Map()
  const cloneMat = m => {
    if (!m) return null
    if (copy.has(m)) return copy.get(m)
    const c = doc.createMaterial(m.getName()).setBaseColorFactor(m.getBaseColorFactor()).setMetallicFactor(m.getMetallicFactor()).setRoughnessFactor(m.getRoughnessFactor()).setEmissiveFactor(m.getEmissiveFactor())
      .setAlphaMode(m.getAlphaMode()).setDoubleSided(m.getDoubleSided())
    const t = m.getBaseColorTexture()
    if (t) c.setBaseColorTexture(doc.createTexture(t.getName()).setImage(t.getImage()).setMimeType(t.getMimeType()))
    copy.set(m, c)
    return c
  }
  for (const n of a.getRoot().listNodes()) {
    const m = n.getMesh()
    if (!m) continue
    const out = doc.createMesh(m.getName())
    for (const ap of m.listPrimitives()) {
      const np = doc.createPrimitive().setMaterial(cloneMat(ap.getMaterial()))
      for (const sem of ap.listSemantics()) {
        const x = ap.getAttribute(sem)
        if (['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'].includes(sem)) np.setAttribute(sem, acc(x.getType(), x.getArray().slice()))
      }
      const ix = ap.getIndices()
      if (ix) { np.setIndices(acc('SCALAR', ix.getArray().slice())); accTris += ix.getCount() / 3 } else accTris += ap.getAttribute('POSITION').getCount() / 3
      out.addPrimitive(np)
    }
    // parts under wear_head / wear_back / wear_body keep that group: the game hangs each group on its own bone
    let g = n, wear = null
    while (g && !wear) { if (/^wear_(head|back|body)/.test(g.getName())) wear = g.getName(); g = g.getParentNode() }
    let parent = holder
    if (wear) parent = holder.listChildren().find(c => c.getName() === wear) || holder.addChild(doc.createNode(wear)).listChildren().find(c => c.getName() === wear)
    parent.addChild(doc.createNode(n.getName() || 'part').setMesh(out).setMatrix(n.getWorldMatrix()))
  }
}
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
fs.writeFileSync(outFile, await io.writeBinary(doc))
const kb = Math.round(fs.statSync(outFile).size / 1024)
console.log(`${outFile}: ${kb} KB, gecko 10616 triangles${accessoryFile ? `, accessory ${accTris} triangles` : ''}`)
if (accTris > 2500) console.log('WARNING: the accessory has more than 2,500 triangles: the game will not show it')
if (kb > 2000) console.log('WARNING: over 2 MB: the game will not load it')
