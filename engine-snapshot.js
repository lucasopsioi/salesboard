// engine-snapshot.js — 把已建好的 store/fin/idc/flow 落盘并原样读回，加速 open()。
// 不重跑 _buildStore 等；dimIndex 反序列化时由 dimDict 反相重建（code = 字典下标，确定性逆映射）。
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const SNAPSHOT_VERSION = 1;
const TA = { Int8Array, Uint8Array, Int32Array, Float64Array };

// ---- 定型数组 ↔ buffer 引用 ----
function taRef(arr, bufs) {
  const i = bufs.length;
  bufs.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  return { ta: arr.constructor.name, b: i, len: arr.length };
}
function taFrom(ref, bin, offsets) {
  const Ctor = TA[ref.ta];
  const bytes = ref.len * Ctor.BYTES_PER_ELEMENT;
  const out = new Ctor(ref.len);
  Buffer.from(out.buffer).set(bin.subarray(offsets[ref.b], offsets[ref.b] + bytes));
  return out;
}
const mapDimCode = (dc, fn) => { const o = {}; for (const k in dc) o[k] = fn(dc[k]); return o; };
const rebuildIndex = dimDict => { const di = {}; for (const k in dimDict) { const m = new Map(); dimDict[k].forEach((v, i) => m.set(v, i)); di[k] = m; } return di; };

// ---- store(PSI) ----
function encStore(s, bufs) {
  if (!s) return null;
  const subtotalCodes = {}; for (const k in s.subtotalCodes) subtotalCodes[k] = [...s.subtotalCodes[k]];
  return {
    n: s.n, dimDict: s.dimDict, dimCode: mapDimCode(s.dimCode, a => taRef(a, bufs)),
    ymd: taRef(s.ymd, bufs), sellIn: taRef(s.sellIn, bufs), sellOut: taRef(s.sellOut, bufs),
    inv: taRef(s.inv, bufs), dos: taRef(s.dos, bufs),
    subtotalCodes, allChan: [...s.allChan], hasNonAllChannel: s.hasNonAllChannel,
    modelToDims: s.modelToDims, repToRegion: s.repToRegion, minYmd: s.minYmd, maxYmd: s.maxYmd,
  };
}
function decStore(e, bin, off) {
  if (!e) return null;
  const subtotalCodes = {}; for (const k in e.subtotalCodes) subtotalCodes[k] = new Set(e.subtotalCodes[k]);
  return {
    n: e.n, dimDict: e.dimDict, dimIndex: rebuildIndex(e.dimDict), dimCode: mapDimCode(e.dimCode, r => taFrom(r, bin, off)),
    ymd: taFrom(e.ymd, bin, off), sellIn: taFrom(e.sellIn, bin, off), sellOut: taFrom(e.sellOut, bin, off),
    inv: taFrom(e.inv, bin, off), dos: taFrom(e.dos, bin, off),
    subtotalCodes, allChan: new Set(e.allChan), hasNonAllChannel: e.hasNonAllChannel,
    modelToDims: e.modelToDims, repToRegion: e.repToRegion, minYmd: e.minYmd, maxYmd: e.maxYmd,
  };
}
// ---- fin ----
function encFin(f, bufs) {
  if (!f) return null;
  return { n: f.n, src: taRef(f.src, bufs), ym: taRef(f.ym, bufs), val: taRef(f.val, bufs),
    dimDict: f.dimDict, dimCode: mapDimCode(f.dimCode, a => taRef(a, bufs)), metricOrder: [...f.metricOrder.entries()] };
}
function decFin(e, bin, off) {
  if (!e) return null;
  return { n: e.n, src: taFrom(e.src, bin, off), ym: taFrom(e.ym, bin, off), val: taFrom(e.val, bin, off),
    dimDict: e.dimDict, dimIndex: rebuildIndex(e.dimDict), dimCode: mapDimCode(e.dimCode, r => taFrom(r, bin, off)),
    metricOrder: new Map(e.metricOrder) };
}
// ---- idc ----
function encIdc(s, bufs) {
  if (!s) return null;
  return { n: s.n, dimDict: s.dimDict, dimCode: mapDimCode(s.dimCode, a => taRef(a, bufs)),
    units: taRef(s.units, bufs), value: taRef(s.value, bufs) };
}
function decIdc(e, bin, off) {
  if (!e) return null;
  return { n: e.n, dimDict: e.dimDict, dimIndex: rebuildIndex(e.dimDict), dimCode: mapDimCode(e.dimCode, r => taFrom(r, bin, off)),
    units: taFrom(e.units, bin, off), value: taFrom(e.value, bin, off) };
}

function save(dir, state) {
  const bufs = [];
  const meta = {
    version: SNAPSHOT_VERSION, sig: state.sig || [], files: state.files || [], dims: state.dims || [],
    store: encStore(state.store, bufs),
    flow: state.flow || null, hasFlow: !!state.hasFlow, flowDate: state.flowDate || 0,
    fin: encFin(state.fin, bufs), finMeta: state.finMeta || null, hasFin: !!state.hasFin,
    idc: encIdc(state.idc, bufs), idcMeta: state.idcMeta || null, hasIdc: !!state.hasIdc,
    bufLens: bufs.map(b => b.length),
  };
  const bin = Buffer.concat(bufs);
  meta.hash = crypto.createHash('sha256').update(bin).digest('hex');
  const binTmp  = path.join(dir, 'snapshot.bin.tmp');
  const jsonTmp = path.join(dir, 'snapshot.json.tmp');
  fs.writeFileSync(binTmp,  bin);
  fs.writeFileSync(jsonTmp, JSON.stringify(meta));
  fs.renameSync(binTmp,  path.join(dir, 'snapshot.bin'));
  fs.renameSync(jsonTmp, path.join(dir, 'snapshot.json'));
}
function load(dir, curSig) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
    if (meta.version !== SNAPSHOT_VERSION) return null;
    if (JSON.stringify(meta.sig) !== JSON.stringify(curSig)) return null;
    const bin = fs.readFileSync(path.join(dir, 'snapshot.bin'));
    const off = []; let p = 0; for (const len of meta.bufLens) { off.push(p); p += len; }
    if (p !== bin.length) return null; // 完整性
    if (typeof meta.hash !== 'string' || crypto.createHash('sha256').update(bin).digest('hex') !== meta.hash) return null; // 内容哈希(必须存在且匹配)
    return {
      files: meta.files, dims: meta.dims,
      store: decStore(meta.store, bin, off),
      flow: meta.flow, hasFlow: meta.hasFlow, flowDate: meta.flowDate,
      fin: decFin(meta.fin, bin, off), finMeta: meta.finMeta, hasFin: meta.hasFin,
      idc: decIdc(meta.idc, bin, off), idcMeta: meta.idcMeta, hasIdc: meta.hasIdc,
    };
  } catch (e) { return null; }
}
module.exports = { SNAPSHOT_VERSION, save, load };
