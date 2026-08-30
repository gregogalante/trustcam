// Builds a per-GOP-signed MP4 fixture out of a real capture: computes each
// GOP's VCL hash exactly like the app will, signs with a throwaway P-256 key,
// and inserts the signature SEI into the next GOP's keyframe — patching
// stsz/stco/co64/mdat like a muxer would. Output feeds test_gopsig_js.mjs.
//
//   node make_gopsig_fixture.mjs ../web/samples/tc_f0dba886.mp4
import fs from 'fs'
import { webcrypto as wc } from 'crypto'

const GOPSIG_UUID = Buffer.from('TrustCamGopSig01', 'ascii')

// ---------- DER helpers ----------
function p1363ToDer (sig) {
  function int (b) {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.slice(i)
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v])
    return Buffer.concat([Buffer.from([0x02, v.length]), v])
  }
  const r = int(Buffer.from(sig.slice(0, 32)))
  const s = int(Buffer.from(sig.slice(32)))
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s])
}

// ---------- MP4 box walk ----------
function * boxes (b, start, end) {
  let p = start
  while (p + 8 <= end) {
    let size = b.readUInt32BE(p)
    const type = b.toString('ascii', p + 4, p + 8)
    let head = 8
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); head = 16 }
    if (size === 0) size = end - p
    if (size < head || p + size > end) return
    yield { type, start: p, content: p + head, end: p + size }
    p += size
  }
}
function find (b, path, start, end) {
  let range = { content: start, end }
  for (const want of path) {
    let hit = null
    for (const box of boxes(b, range.content, range.end)) {
      if (box.type === want) { hit = box; break }
    }
    if (!hit) return null
    range = hit
  }
  return range
}

// ---------- trak table extraction (absolute positions, for patching) ----------
function trakTables (b, trak) {
  const hdlr = find(b, ['mdia', 'hdlr'], trak.content, trak.end)
  const stbl = find(b, ['mdia', 'minf', 'stbl'], trak.content, trak.end)
  const kind = b.toString('ascii', hdlr.content + 8, hdlr.content + 12)
  const t = { kind }
  for (const x of boxes(b, stbl.content, stbl.end)) t[x.type] = x
  return t
}

function sampleLayout (b, t) {
  const count = b.readUInt32BE(t.stsz.content + 8)
  const fixed = b.readUInt32BE(t.stsz.content + 4)
  if (fixed) throw new Error('fixed-size samples unsupported')
  const sizes = []
  for (let i = 0; i < count; i++) sizes.push(b.readUInt32BE(t.stsz.content + 12 + i * 4))
  const co = t.stco || t.co64
  const nChunks = b.readUInt32BE(co.content + 4)
  const chunkOff = []
  for (let i = 0; i < nChunks; i++) {
    chunkOff.push(t.stco ? b.readUInt32BE(co.content + 8 + i * 4)
      : Number(b.readBigUInt64BE(co.content + 8 + i * 8)))
  }
  const nRuns = b.readUInt32BE(t.stsc.content + 4)
  const runs = []
  for (let i = 0; i < nRuns; i++) {
    runs.push({ first: b.readUInt32BE(t.stsc.content + 8 + i * 12), per: b.readUInt32BE(t.stsc.content + 12 + i * 12) })
  }
  const sync = new Set()
  if (t.stss) {
    const n = b.readUInt32BE(t.stss.content + 4)
    for (let i = 0; i < n; i++) sync.add(b.readUInt32BE(t.stss.content + 8 + i * 4))
  }
  const samples = []
  let s = 0
  for (let chunk = 0; chunk < nChunks && s < count; chunk++) {
    let per = runs[0].per
    for (const r of runs) { if (chunk + 1 >= r.first) per = r.per }
    let off = chunkOff[chunk]
    for (let k = 0; k < per && s < count; k++) {
      samples.push({ off, size: sizes[s], sync: sync.size === 0 || sync.has(s + 1), idx: s })
      off += sizes[s]
      s++
    }
  }
  return { samples, chunkOff, co }
}

// H.264 emulation prevention: escape a raw RBSP for transport
function escapeRbsp (rbsp) {
  const out = []
  let zeros = 0
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) { out.push(3); zeros = 0 }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Buffer.from(out)
}

function buildSei (gopIndex, spki, sig) {
  const body = Buffer.alloc(16 + 1 + 4 + 2 + spki.length + 2 + sig.length)
  GOPSIG_UUID.copy(body, 0)
  body[16] = 1
  body.writeUInt32BE(gopIndex, 17)
  body.writeUInt16BE(spki.length, 21)
  spki.copy(body, 23)
  body.writeUInt16BE(sig.length, 23 + spki.length)
  sig.copy(body, 25 + spki.length)
  // SEI: payload_type=5, ff-chained size, payload, rbsp stop bit
  const sizeChain = []
  let n = body.length
  while (n >= 255) { sizeChain.push(255); n -= 255 }
  sizeChain.push(n)
  const rbsp = Buffer.concat([Buffer.from([5]), Buffer.from(sizeChain), body, Buffer.from([0x80])])
  const nal = Buffer.concat([Buffer.from([0x06]), escapeRbsp(rbsp)]) // header + escaped payload
  const len = Buffer.alloc(4)
  len.writeUInt32BE(nal.length, 0)
  return Buffer.concat([len, nal]) // AVCC framing
}

const src = process.argv[2] || '../web/samples/tc_f0dba886.mp4'
let b = fs.readFileSync(src)
// drop the TrustCam trailer if present: the fixture is a plain bitstream test
if (b.toString('ascii', b.length - 8) === 'TCPROOF1') {
  const jsonLen = b.readUInt32BE(b.length - 12)
  b = b.subarray(0, b.length - 20 - jsonLen)
}

const key = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const spki = Buffer.from(await wc.subtle.exportKey('spki', key.publicKey))

const moov = find(b, ['moov'], 0, b.length)
const mdat = [...boxes(b, 0, b.length)].find(x => x.type === 'mdat')
const traks = [...boxes(b, moov.content, moov.end)].filter(x => x.type === 'trak').map(x => trakTables(b, x))
const video = traks.find(t => t.kind === 'vide')
const avc1 = find(b, ['avc1'], video.stsd.content + 8, video.stsd.end)
const avcC = find(b, ['avcC'], avc1.content + 78, avc1.end)
const nalLen = (b[avcC.content + 4] & 0x03) + 1
const layout = sampleLayout(b, video)

// GOP walk: hash VCL NALs, sign at boundaries, plan SEI insertions
async function signHash (hash) {
  return p1363ToDer(new Uint8Array(await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, hash)))
}
const insertions = [] // { at (file offset), bytes, sampleIdx }
let gopNals = []
let gopIndex = -1
let lastGop = null
for (const s of layout.samples) {
  if (s.sync) {
    if (gopIndex >= 0) {
      const hash = Buffer.from(await wc.subtle.digest('SHA-256', Buffer.concat(gopNals)))
      const sig = await signHash(hash)
      insertions.push({ at: s.off, bytes: buildSei(gopIndex, spki, sig), sampleIdx: s.idx })
    }
    gopIndex++
    gopNals = []
  }
  let p = s.off
  const end = s.off + s.size
  while (p + nalLen <= end) {
    let len = 0
    for (let i = 0; i < nalLen; i++) len = len * 256 + b[p + i]
    p += nalLen
    if (len <= 0 || p + len > end) break
    const type = b[p] & 0x1f
    if (type === 1 || type === 5) gopNals.push(b.subarray(p, p + len))
    p += len
  }
}
// final GOP -> proof-side record
{
  const hash = Buffer.from(await wc.subtle.digest('SHA-256', Buffer.concat(gopNals)))
  const sig = await signHash(hash)
  lastGop = { i: gopIndex, spki: spki.toString('base64'), sig: sig.toString('base64') }
}

// ---------- patch tables in place, then assemble with insertions ----------
const patched = Buffer.from(b) // copy
// video stsz: grow the sync samples that received a SEI
for (const ins of insertions) {
  const pos = video.stsz.content + 12 + ins.sampleIdx * 4
  patched.writeUInt32BE(patched.readUInt32BE(pos) + ins.bytes.length, pos)
}
// every trak's chunk offsets: shift by insertions strictly before the chunk
const shiftBefore = off => insertions.reduce((a, i) => a + (i.at < off ? i.bytes.length : 0), 0)
for (const t of traks) {
  const co = t.stco || t.co64
  const n = patched.readUInt32BE(co.content + 4)
  for (let i = 0; i < n; i++) {
    if (t.stco) {
      const pos = co.content + 8 + i * 4
      patched.writeUInt32BE(patched.readUInt32BE(pos) + shiftBefore(patched.readUInt32BE(pos)), pos)
    } else {
      const pos = co.content + 8 + i * 8
      const v = patched.readBigUInt64BE(pos)
      patched.writeBigUInt64BE(v + BigInt(shiftBefore(Number(v))), pos)
    }
  }
}
// mdat size: 32-bit, or 64-bit largesize when the header says size==1
const total = insertions.reduce((a, i) => a + i.bytes.length, 0)
if (patched.readUInt32BE(mdat.start) === 1) {
  patched.writeBigUInt64BE(patched.readBigUInt64BE(mdat.start + 8) + BigInt(total), mdat.start + 8)
} else {
  patched.writeUInt32BE(patched.readUInt32BE(mdat.start) + total, mdat.start)
}

// assemble
const parts = []
let cursor = 0
for (const ins of insertions.sort((a, z) => a.at - z.at)) {
  parts.push(patched.subarray(cursor, ins.at), ins.bytes)
  cursor = ins.at
}
parts.push(patched.subarray(cursor))
const outBuf = Buffer.concat(parts)

fs.writeFileSync('results/gopsig_fixture.mp4', outBuf)
fs.writeFileSync('results/gopsig_meta.json', JSON.stringify({
  gopCount: gopIndex + 1, lastGop, spki: spki.toString('base64'), insertions: insertions.length
}, null, 1))
console.log(`fixture: ${gopIndex + 1} GOPs, ${insertions.length} SEI inserted, ${outBuf.length} bytes`)
