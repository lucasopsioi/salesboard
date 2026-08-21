/* 产品概述(.docx)导入 —— 纯函数核心(UMD,可测)
   路线:确定性解析为主(docx→document.xml→表格/段落→标签映射+分叉消解),LLM 只兜残余行(UI 层调用)。
   两级映射:认证型号(VNT-Wxx) ↔ 下属 offering 集合(Vernet-WxxYY;Models 表显式 ∪ 规格/配件行前缀推断)。
   设计文档:design/产品概述导入-设计方案.md;实测:29 断言基于 Slate 12X 完整原文镜像。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RoadmapImport = api;
})(this, function () {
  /* ---------- document.xml → 段落 + 表格(按出现顺序) ---------- */
  function parseDocXml(xml) {
    const tables = [], paras = [];
    const blockRe = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
    const txt = s => [...s.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map(x => x[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join('');
    let m;
    while ((m = blockRe.exec(xml))) {
      if (m[0].lastIndexOf('<w:tbl', 0) === 0) {
        const rows = [];
        const trRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g; let r;
        while ((r = trRe.exec(m[0]))) {
          const cells = [];
          const tcRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g; let c;
          while ((c = tcRe.exec(r[1]))) {
            const ps = [...c[1].matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map(p => txt(p[1]));
            cells.push(ps.join('\n').trim());
          }
          rows.push(cells);
        }
        tables.push(rows);
      } else { const t = txt(m[0]).trim(); if (t) paras.push(t); }
    }
    return { tables, paras };
  }

  /* ---------- 型号/offering token 文法 ----------
     VNT-Wxx=认证型号 · Vernet-WxxYY / 裸 WxxYY=offering · 裸 Wxx=型号简写(VNT-W20/W30 里的 W30)。 */
  const TOK_RE = /\b(VNT-W\d{2}|Vernet-W\d{2}[A-Z]{1,2}|W\d{2}[A-Z]{1,2}|W\d{2})\b/g;
  function canonTok(t) {
    if (/^VNT-/i.test(t)) return { kind: 'model', id: t.toUpperCase() };
    if (/^Vernet-/i.test(t)) return { kind: 'offering', id: t.replace(/^Vernet-/i, '').toUpperCase() };
    if (/^W\d{2}[A-Z]{1,2}$/i.test(t)) return { kind: 'offering', id: t.toUpperCase() };
    return { kind: 'model', id: 'VNT-' + t.toUpperCase() };
  }
  const offToModel = off => 'VNT-' + String(off).slice(0, 3).toUpperCase();
  // 仅由 / , and 连接的相邻 token 归同组(如 VNT-W20/W30);中间夹了别的字=各自成组(如 Storage 行)
  function tokenGroups(text) {
    const groups = []; let m; TOK_RE.lastIndex = 0;
    while ((m = TOK_RE.exec(text))) {
      const tok = canonTok(m[1]);
      const last = groups[groups.length - 1];
      if (last && /^\s*(\/|,|and)\s*$/.test(text.slice(last.end, m.index))) { last.toks.push(tok); last.end = m.index + m[1].length; }
      else groups.push({ start: m.index, end: m.index + m[1].length, toks: [tok] });
    }
    return groups;
  }
  function groupHits(group, certModel, offerings) {
    return group.toks.some(t => (t.kind === 'model' && t.id === certModel) ||
      (t.kind === 'offering' && ((offerings && offerings.has(t.id)) || offToModel(t.id) === certModel)));
  }

  /* ---------- 行内分叉消解:子句级(; / ".+大写" / 换行切) + others 兜底 ----------
     无 token 子句=公共保留;有 token 子句只取本型号/本 offering 段,组前公共前导(Input/Rear 50MP)保留。 */
  function resolveForks(value, certModel, offerings) {
    const clauses = String(value == null ? '' : value).split(/\n|;\s*|(?<=\.)\s+(?=[A-Z])/).filter(s => s.trim());
    const kept = []; let forked = false, matchedAny = false;
    for (const cl of clauses) {
      const gs = tokenGroups(cl);
      if (!gs.length) { kept.push(cl.trim()); continue; }
      forked = true;
      const pre = cl.slice(0, gs[0].start).replace(/[\s:,-]+$/, '').trim();
      const segs = [];
      for (let i = 0; i < gs.length; i++) {
        const seg = cl.slice(gs[i].end, i + 1 < gs.length ? gs[i + 1].start : cl.length).replace(/^[\s:：]+|[\s,\/]+$/g, '');
        segs.push({ g: gs[i], seg });
      }
      let mine = segs.filter(s => groupHits(s.g, certModel, offerings));
      if (!mine.length) {   // others 兜底:如 "VNT-W20/W30 use C2C cable, others use A2C cable"
        const oth = segs.find(s => /\bothers?\b/i.test(s.seg));
        if (oth) mine = [{ g: oth.g, seg: oth.seg.replace(/^.*?\bothers?\b\s*/i, '') }];
      }
      if (mine.length) { matchedAny = true; kept.push((pre ? pre + ' ' : '') + mine.map(s => s.seg).filter(Boolean).join(' / ')); }
    }
    return { value: kept.join('; '), forked, matched: !forked || matchedAny };
  }
  // offering 级取值(Storage/配件标配):命中本型号 offering 集合的 token → 其后段落
  function perOffering(value, offerings) {
    const s = String(value == null ? '' : value);
    const gs = tokenGroups(s); const out = {};
    gs.forEach((g, i) => {
      const seg = s.slice(g.end, i + 1 < gs.length ? gs[i + 1].start : undefined).replace(/^[\s:：]+|[\s,\/;]+$/g, '');
      g.toks.filter(t => t.kind === 'offering' && offerings && offerings.has(t.id)).forEach(t => { out[t.id] = seg; });
    });
    return out;
  }

  /* ---------- 标签映射(中英同义词;格式漂移在此扩) ---------- */
  const LABEL_MAP = [
    [/^design|appearance|外观|形态/i, 'design'], [/^colou?r$|颜色/i, 'colors'],
    [/dimension|尺寸/i, 'dimensions'], [/weight|重量/i, 'weight'], [/battery type|电池类型/i, 'batteryType'],
    [/^display|屏幕(?!尺寸)/i, 'display'], [/^tp$|touch panel|触控/i, 'touchPanel'],
    [/network standard|网络制式/i, 'networkStandard'], [/frequency band|频段/i, 'networkBands'],
    [/^storage card|memory card|存储卡/i, 'memoryCard'], [/^storage|存储/i, 'storage'],
    [/cpu|处理器/i, 'cpu'], [/button|按键/i, 'buttons'], [/port|接口/i, 'ports'],
    [/gps|定位/i, 'gps'], [/^wi-?fi$/i, 'wifi'], [/^usb$/i, 'usb'], [/bluetooth|蓝牙/i, 'bluetooth'],
    [/nearlink|星闪/i, 'nearlink'], [/nfc/i, 'nfc'], [/sensor|传感器/i, 'sensors'],
    [/^camera$|摄像头$/i, 'camera'], [/radio|收音/i, 'radio'],
    [/^battery$|电池(?!类型)/i, 'battery'], [/^power$|电源/i, 'power'],
    [/wireless charging|无线充电/i, 'wirelessCharging'], [/temperature|温度/i, 'temperature'],
    [/humidity|湿度/i, 'humidity'], [/certification|认证/i, 'certifications'],
    [/^os$|operating system|操作系统/i, 'os'], [/user interface|^ui$/i, 'ui'],
    [/browser|浏览器/i, 'browser'], [/input method|输入法/i, 'inputMethod'], [/e-?mail|邮件/i, 'email'],
    [/^multimedia|多媒体/i, 'multimedia'], [/streaming|流媒体/i, 'streaming'], [/audio device|音频设备|扬声器/i, 'audioDevice'],
    [/camera resolution|摄像分辨率/i, 'cameraResolution'], [/photo shooting|拍照/i, 'photoShooting'],
    [/video shooting|摄像(?!头)/i, 'videoShooting'], [/focus|对焦/i, 'focus'], [/flash|闪光灯/i, 'flash'],
    [/other features|其他特性/i, 'otherFeatures'], [/transmission|传输/i, 'transmission'],
    [/software update|软件升级/i, 'softwareUpdates'], [/office|办公/i, 'office'],
  ];
  function mapLabel(l) { const s = String(l == null ? '' : l).trim(); for (const [re, k] of LABEL_MAP) if (re.test(s)) return k; return null; }

  /* ---------- 合并大行子字段拆分(Display/Camera/Battery/Power) ---------- */
  function subSplit(key, v) {
    const out = {}; const s = String(v == null ? '' : v);
    const g = (re) => { const m = s.match(re); return m ? m[1].trim() : null; };
    if (key === 'display') {
      out.displaySize = g(/([\d.]+\s*inch(?:es)?)/i); out.resolution = g(/(\d{3,4}\s*[x×]\s*\d{3,4})/i);
      out.refreshRate = g(/((?:\d+\/)*\d+\s*Hz[^;]*)/i); out.ppi = g(/(\d+)\s*PPI/i);
      out.contrast = g(/contrast\s*([\d,]+:\d+)/i); out.colorGamut = g(/gamut\s*([A-Za-z0-9\- ]+?)(?:;|$)/i);
      out.brightness = g(/brightness\s*([^;]+)/i); out.screenRatio = g(/screen-to-body\s*([\d.]+%)/i);
      out.displayType = /LCD/i.test(s) ? 'LCD' : (/OLED/i.test(s) ? 'OLED' : null);
    }
    if (key === 'camera') {
      const r = s.match(/Rear\s*([^;]+)/i), f = s.match(/Front\s*([^;]+)/i);
      if (r) out.rearCamera = r[1].trim(); if (f) out.frontCamera = f[1].trim();
    }
    if (key === 'battery') {
      const c = s.match(/([\d,]+\s*mAh[^;]*)/i); if (c) out.batteryCapacity = c[1].trim();
      const ch = s.match(/charge\s*([^;]+)/i); if (ch) out.charging = ch[1].trim();
    }
    if (key === 'power') {
      const i = s.match(/Input\s*([^;]+)/i), o = s.match(/Output\s*([^;]+)/i);
      if (i) out.powerInput = i[1].trim(); if (o) out.powerOutput = o[1].trim();
    }
    Object.keys(out).forEach(k => { if (out[k] == null) delete out[k]; });
    return out;
  }

  /* ---------- Models 表 → 两级映射 ---------- */
  function parseModels(rows) {
    if (!rows || !rows.length) return null;
    const head = rows[0].map(s => String(s || '').toLowerCase());
    if (!(head.some(h => h.includes('model')) && head.some(h => h.includes('offering')))) return null;
    const idx = (kw, not) => head.findIndex(h => h.includes(kw) && (!not || !h.includes(not)));
    const iM = idx('model', 'marketing'), iO = idx('offering'), iS = idx('spec'), iK = idx('marketing');
    const models = {};
    rows.slice(1).forEach(r => {
      const cert = String(r[iM] || '').trim().toUpperCase(); if (!cert) return;
      const m = models[cert] = models[cert] || { certModel: cert, offerings: {}, marketing: '' };
      if (iK >= 0 && r[iK]) m.marketing = String(r[iK]).trim();
      const offLines = String(r[iO] || '').split('\n'), specLines = iS >= 0 ? String(r[iS] || '').split('\n') : [];
      offLines.forEach((ln, i) => {
        const t = ln.match(/(?:Vernet-)?(W\d{2}[A-Z]{1,2})/i); if (!t) return;
        const id = t[1].toUpperCase();
        const region = (ln.match(/\(([^)]+)\)/) || [])[1] || '';
        const o = m.offerings[id] = m.offerings[id] || { id, region, specs: [] };
        if (specLines[i]) o.specs.push(specLines[i].trim());
      });
    });
    return Object.keys(models).length ? models : null;
  }

  /* ---------- 整篇解析 ---------- */
  function parseOverview(xml) {
    const { tables, paras } = parseDocXml(xml);
    // Models 表 + 两级映射(规格/配件行扫出 Models 表漏列的 offering,前缀推断归属并标 inferred)
    let models = null;
    for (const t of tables) { const m = parseModels(t); if (m) { models = m; break; } }
    models = models || {};
    const allText = tables.flat(2).join('\n');
    const seen = new Set(Object.values(models).flatMap(m => Object.keys(m.offerings)));
    const offRe = /\b(?:Vernet-)?(W\d{2}[A-Z]{1,2})\b/g; let m2;
    while ((m2 = offRe.exec(allText))) {
      const id = m2[1].toUpperCase(); if (seen.has(id)) continue; seen.add(id);
      const cert = offToModel(id);
      if (models[cert]) models[cert].offerings[id] = { id, region: '', specs: [], inferred: true };
    }
    // 规格表(首列 Item) / 配件表(No.+Item)
    const specTables = [], accTables = [];
    tables.forEach(t => {
      const head = (t[0] || []).map(s => String(s || '').toLowerCase());
      if ((head[0] || '').includes('item')) specTables.push(t);
      else if ((head[0] || '').includes('no') && head.some(h => h.includes('item'))) accTables.push(t);
    });
    // 2.1/2.2 自由段落:功能概述 + 卖点候选(- 开头的行)
    const highlights = paras.filter(p => /^[-•·]\s*/.test(p)).map(p => p.replace(/^[-•·]\s*/, '').trim()).filter(Boolean);
    const funcOverview = paras.find(p => /is a .*(tablet|phone|watch|laptop)|developed by/i.test(p)) || '';
    // 文档元
    const docTitle = paras[0] || '';
    const issue = (paras.find(p => /^Issue\b/i.test(p)) || '').trim();
    const dateP = paras.find(p => /\d{4}-\d{2}-\d{2}/.test(p)) || '';
    const releaseDate = (dateP.match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
    return { models, specTables, accTables, highlights, funcOverview, meta: { docTitle, issue, releaseDate } };
  }

  /* ---------- 以某认证型号视角抽取 ---------- */
  function extractForModel(parsed, certModel) {
    certModel = String(certModel || '').trim().toUpperCase();
    const model = (parsed.models || {})[certModel] || null;
    const offerings = new Set(model ? Object.keys(model.offerings) : []);
    const specs = {}, perOff = {}, unrecognized = [], forkUnmatched = [];
    (parsed.specTables || []).forEach(t => {
      t.slice(1).forEach(r => {
        if (!r || r.length < 2) return;
        const label = r[0], raw = r[1];
        const key = mapLabel(label);
        if (!key) { unrecognized.push({ label, value: raw }); return; }
        const res = resolveForks(raw, certModel, offerings);
        if (res.forked && !res.matched) forkUnmatched.push({ label, key, value: raw });
        const po = perOffering(raw, offerings);
        if (Object.keys(po).length) perOff[key] = po;
        if (res.value && specs[key] == null) specs[key] = res.value;
        const sub = subSplit(key, res.value);
        Object.keys(sub).forEach(k => { if (specs[k] == null) specs[k] = sub[k]; });
      });
    });
    // 配件表:标配判定(无分叉=看 Standard;有分叉=本型号/offering 命中且 Standard) + others 兜底
    const accessories = [];
    (parsed.accTables || []).forEach(t => {
      const head = (t[0] || []).map(s => String(s || '').toLowerCase());
      const iItem = head.findIndex(h => h.includes('item'));
      const iQty = head.findIndex(h => h.includes('quantity') || h.includes('qty'));
      const iDesc = head.findIndex(h => h.includes('desc'));
      t.slice(1).forEach(r => {
        if (!r || r.length <= iItem) return;
        const item = r[iItem] || '', desc = iDesc >= 0 ? (r[iDesc] || '') : '';
        const gs = tokenGroups(desc);
        const std = !gs.length ? /standard/i.test(desc)
          : (gs.some(g => groupHits(g, certModel, offerings)) && /standard/i.test(desc));
        const res = resolveForks(desc, certModel, offerings);
        accessories.push({ item, qty: iQty >= 0 ? (r[iQty] || '') : '', desc, mine: res.value, std, perOff: perOffering(desc, offerings) });
      });
    });
    return { certModel, model, offerings: [...offerings], specs, perOffering: perOff,
      accessories, unrecognized, forkUnmatched, highlights: parsed.highlights || [],
      funcOverview: parsed.funcOverview || '', meta: parsed.meta || {}, marketing: model ? model.marketing : '' };
  }

  /* ---------- 预览/表单用:分组与中文名 ---------- */
  const KEY_LABELS = {
    design: '形态', colors: '配色描述', dimensions: '尺寸', weight: '重量',
    displaySize: '屏幕尺寸', displayType: '屏幕材质', resolution: '分辨率', refreshRate: '刷新率', ppi: 'PPI',
    contrast: '对比度', colorGamut: '色域', brightness: '亮度', screenRatio: '屏占比', touchPanel: 'TP特性', display: '屏幕(原文)',
    networkStandard: '网络制式', networkBands: '网络频段', wifi: 'Wi-Fi', bluetooth: '蓝牙', usb: 'USB',
    nearlink: '星闪', nfc: 'NFC', gps: 'GPS', transmission: '传输能力',
    storage: '存储', memoryCard: '存储卡',
    cpu: 'CPU', buttons: '按键', ports: '接口', radio: '收音机',
    rearCamera: '后摄', frontCamera: '前摄', flash: '闪光灯', camera: '摄像头(原文)', cameraResolution: '摄像分辨率',
    photoShooting: '拍照模式', videoShooting: '录像能力', focus: '对焦',
    batteryType: '电池类型', batteryCapacity: '电池容量', charging: '充电/续航', battery: '电池(原文)',
    powerInput: '电源输入', powerOutput: '适配器输出', power: '电源(原文)', wirelessCharging: '无线充电',
    temperature: '工作温度', humidity: '湿度',
    os: '操作系统', ui: 'UI', browser: '浏览器', inputMethod: '输入法', email: '邮件',
    otherFeatures: '特性清单', softwareUpdates: '软件升级', office: '办公',
    multimedia: '多媒体格式', streaming: '流媒体', audioDevice: '音频设备',
    sensors: '传感器', certifications: '认证',
  };
  const SPEC_GROUPS = [
    { name: '外观', keys: ['design', 'colors', 'dimensions', 'weight'] },
    { name: '屏幕', keys: ['displaySize', 'displayType', 'resolution', 'refreshRate', 'ppi', 'contrast', 'colorGamut', 'brightness', 'screenRatio', 'touchPanel', 'display'] },
    { name: '网络连接', keys: ['networkStandard', 'networkBands', 'wifi', 'bluetooth', 'usb', 'nearlink', 'nfc', 'gps', 'transmission'] },
    { name: '存储', keys: ['storage', 'memoryCard'] },
    { name: '设备', keys: ['cpu', 'buttons', 'ports', 'radio'] },
    { name: '摄像头', keys: ['rearCamera', 'frontCamera', 'flash', 'camera', 'cameraResolution', 'photoShooting', 'videoShooting', 'focus'] },
    { name: '电池充电', keys: ['batteryType', 'batteryCapacity', 'charging', 'battery', 'powerInput', 'powerOutput', 'power', 'wirelessCharging', 'temperature', 'humidity'] },
    { name: 'OS/软件', keys: ['os', 'ui', 'browser', 'inputMethod', 'email', 'otherFeatures', 'softwareUpdates', 'office'] },
    { name: '多媒体/音频', keys: ['multimedia', 'streaming', 'audioDevice'] },
    { name: '传感器', keys: ['sensors'] },
    { name: '认证', keys: ['certifications'] },
  ];

  /* ---------- LLM 兜底提示词(残余行 → JSON;UI 层拿去调 aiChatLocal) ---------- */
  function llmPrompt(residualRows, certModel) {
    const keys = Object.keys(KEY_LABELS);
    return '你是产品规格抽取器。下面是产品概述文档里未能自动识别的行(标签: 值),目标认证型号 ' + certModel + '。\n' +
      '请把每行映射到候选字段并抽取该型号的值,只输出 JSON 对象 {"字段key":"值"},不要解释。候选字段key:\n' + keys.join(', ') + '\n\n' +
      residualRows.map(r => r.label + ': ' + r.value).join('\n');
  }
  function parseLlmJson(text) {
    try {
      const m = String(text || '').match(/\{[\s\S]*\}/); if (!m) return null;
      const o = JSON.parse(m[0]); if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      const out = {}; Object.keys(o).forEach(k => { if (KEY_LABELS[k] && o[k] != null && String(o[k]).trim()) out[k] = String(o[k]).trim(); });
      return out;
    } catch (e) { return null; }
  }

  return { parseDocXml, tokenGroups, canonTok, offToModel, resolveForks, perOffering, mapLabel, subSplit,
    parseModels, parseOverview, extractForModel, KEY_LABELS, SPEC_GROUPS, llmPrompt, parseLlmJson };
});
