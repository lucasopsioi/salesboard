'use strict';
/* ============================================================
   路标·自然语言写入内核（UMD 纯函数，2026-09-01 用户需求）
   AI 从自然语言/文档抽取出结构化 payload 后，经这里合入路标产品数组：
   - 按 name 归一匹配已有产品（互含）→ 更新；找不到 → 新建
   - 已知字段填已知字段；认不出的信息一律追加进 customInfo（带日期标签，绝不丢）
   - 返回 {products, action, name, applied[], extras[]} —— 渲染层负责 save/重绘
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RoadmapNL = api;
})(this, function () {

  const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/[\s\-_/()（）"']/g, '');

  // AI 可写字段白名单（与 blankProduct 对齐；此外一律进 customInfo）
  const FIELDS = {
    name: 'string', internalCode: 'string', certModel: 'string',
    shipLate: 'ym', shipEarly: 'ym', salesEnd: 'ym', eomPlan: 'ym',
    compositeRrpUsd: 'number', seriesGroup: 'string', category: 'string',
    psiLink: 'string', predecessorId: 'string', predecessor: 'ref', customInfo: 'append',
  };

  const normYm = v => {
    const m = String(v == null ? '' : v).trim().match(/^(\d{4})[\/\-年.]?(\d{1,2})/);
    return m ? (m[1] + '/' + String(+m[2]).padStart(2, '0')) : '';
  };

  function findProduct(products, name) {
    const n = norm(name);
    if (!n) return null;
    let hit = (products || []).find(p => norm(p.name) === n);
    if (hit) return hit;
    const cands = (products || []).filter(p => {
      const np = norm(p.name);
      return np && (np.indexOf(n) >= 0 || n.indexOf(np) >= 0);
    });
    return cands.length === 1 ? cands[0] : null;   // 模糊多命中不猜，走新建让用户看见
  }

  /* payload = { name(必填), fields?{白名单字段}, skus?[{name,color,ram,rom,chip}], sellingPoints?[..], extras?{任意键值} , sourceText? } */
  function upsertProduct(products, payload, blankFactory) {
    const out = { products: products || [], action: '', name: '', applied: [], extras: [] };
    const name = String(payload && payload.name || '').trim();
    if (!name) return Object.assign(out, { error: 'name 必填（要写入哪个产品）' });
    let p = findProduct(out.products, name);
    if (!p) {
      p = (typeof blankFactory === 'function') ? blankFactory() : { id: 'nl' + Date.now(), skus: [], sellingPoints: [], customInfo: '' };
      p.name = name;
      out.products = out.products.concat([p]);
      out.action = 'created';
    } else {
      out.action = 'updated';
    }
    out.name = p.name;

    const f = (payload && payload.fields) || {};
    Object.keys(f).forEach(k => {
      const kind = FIELDS[k];
      const v = f[k];
      if (v == null || v === '') return;
      if (!kind) { out.extras.push(k + '：' + v); return; }
      if (kind === 'ym') { const ym = normYm(v); if (ym) { p[k] = ym; out.applied.push(k + '=' + ym); } return; }
      // 前代产品：按名字在既有产品里解析成 id（模型只会说「前代是 Slate SE 11」）；解析不到进备注不丢
      if (kind === 'ref' || (k === 'predecessorId' && !out.products.some(x => x.id === v))) {
        const t = findProduct(out.products.filter(x => x !== p), String(v));
        if (t) { p.predecessorId = t.id; out.applied.push('predecessorId=' + t.name); } else { out.extras.push('前代产品：' + v); }
        return;
      }
      if (kind === 'number') { const n2 = parseFloat(v); if (isFinite(n2)) { p[k] = Math.round(n2 * 100) / 100; out.applied.push(k + '=' + p[k]); } return; }
      if (kind === 'append') return;   // customInfo 统一走 extras 通道
      p[k] = String(v).trim(); out.applied.push(k + '=' + p[k]);
    });

    // SKU：按名称合并（同名更新，缺名跳过；不删已有）
    if (Array.isArray(payload && payload.skus)) {
      p.skus = Array.isArray(p.skus) ? p.skus : [];
      payload.skus.slice(0, 12).forEach(sk => {
        if (!sk || !sk.name) return;
        let t = p.skus.find(x => norm(x.name) === norm(sk.name));
        if (!t) { t = { name: String(sk.name), color: '#1E9E57' }; p.skus.push(t); }
        ['color', 'ram', 'rom', 'chip', 'ean'].forEach(kk => { if (sk[kk]) t[kk] = String(sk[kk]); });
        out.applied.push('sku:' + sk.name);
      });
      if (p.skus.length > 1 && !p.skus[0].name) p.skus = p.skus.filter(x => x.name);   // 挤掉工厂空壳行
    }

    // 卖点：填进空位（不覆盖已有非空卖点）
    if (Array.isArray(payload && payload.sellingPoints)) {
      p.sellingPoints = Array.isArray(p.sellingPoints) ? p.sellingPoints : [];
      payload.sellingPoints.slice(0, 6).forEach(sp => {
        const txt = typeof sp === 'string' ? sp : (sp && (sp.cn || sp.en));
        if (!txt) return;
        const slot = p.sellingPoints.find(x => x && !x.cn && !x.en);
        if (slot) slot.cn = String(txt); else p.sellingPoints.push({ cn: String(txt), en: '' });
        out.applied.push('卖点:' + String(txt).slice(0, 16));
      });
    }

    // extras（白名单外的键值，如 VN1编码/VN2编码）+ payload.extras → customInfo 追加，绝不丢
    const ex = (payload && payload.extras) || {};
    Object.keys(ex).forEach(k => { if (ex[k] != null && ex[k] !== '') out.extras.push(k + '：' + ex[k]); });
    if (out.extras.length) {
      const stamp = '【AI 录入 ' + new Date().toISOString().slice(0, 10) + '】';
      const block = stamp + '\n' + out.extras.join('\n');
      p.customInfo = (p.customInfo ? (p.customInfo + '\n') : '') + block;
      out.applied.push('customInfo+' + out.extras.length + '条');
    }
    return out;
  }

  return { upsertProduct, findProduct, normYm, FIELDS, norm };
});
