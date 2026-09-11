/* ============================================================
   PPT 模板学习流程（2026-09-01 用户需求）
   给一个现成 PPT → AI 逐形状识别哪些是数据字段（绑定提案）→ 不确定的
   列成问题问用户 → 确认后存成模板（源 pptx + 绑定）→ 之后一句话刷新：
   按绑定重查最新数据 → 原位替换文本重打包（版式不动）→ 出新 PPT。
   全程事件走 onFlow 可视；多轮问答用会话态 pendingTpl 承接。
   ============================================================ */
'use strict';
(function () {
  const J = (o) => { try { return JSON.stringify(o); } catch (e) { return '{}'; } };

  // 从 LLM 回复中抠 JSON（```json 块优先，其次首个 {...} / [...]）
  function pickJson(text) {
    const t = String(text || '');
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cand = [];
    if (fence) cand.push(fence[1]);
    const b1 = t.indexOf('['), b2 = t.indexOf('{');
    const st = (b1 >= 0 && (b2 < 0 || b1 < b2)) ? b1 : b2;
    if (st >= 0) cand.push(t.slice(st));
    for (const c of cand) {
      for (let end = c.length; end > 2; end--) {
        try { return JSON.parse(c.slice(0, end)); } catch (e) {}
        if (end > 200) end -= Math.floor(end / 50); // 长文本大步回退
      }
    }
    return null;
  }

  // 形状结构 → 给 LLM 的紧凑描述（省 token；表格只给表头+首行样例+行列数）
  function describeStructure(struct) {
    const lines = [];
    (struct.slides || []).forEach((sl, si) => {
      lines.push('== 第' + (si + 1) + '页 (' + sl.file + ') ==');
      (sl.shapes || []).forEach((sh, i) => {
        const pos = sh.pos && sh.pos.x != null ? ('@(' + sh.pos.x + ',' + sh.pos.y + ')') : '';
        if (sh.type === 'table') {
          const head = (sh.rows[0] || []).join(' | ');
          const r1 = (sh.rows[1] || []).join(' | ');
          lines.push('[' + i + '] 表格' + pos + ' ' + sh.rows.length + '行x' + (sh.rows[0] || []).length + '列  表头: ' + head.slice(0, 160) + (r1 ? ('  首行: ' + r1.slice(0, 160)) : ''));
        } else {
          const t = String(sh.text || '').replace(/\n/g, '⏎').slice(0, 160);
          if (t.trim()) lines.push('[' + i + '] 文本' + pos + ' ' + t);
        }
      });
    });
    return lines.join('\n');
  }

  const LEARN_SYS = [
    '你是 PPT 模板分析师。给你一个 PPT 的结构（每页的形状编号、位置、文本/表格内容），',
    '判断每个形状是「静态文字」（标题/口号/固定说明，刷新时不变）还是「数据字段」（数字/日期/带数字的结论，刷新时要换成最新值）。',
    '对每个数据字段写清楚：它是什么数据（描述到能取数的程度：什么指标、什么维度过滤、什么期间口径）、原文的文字模板（把会变的数字换成 {v} 占位，其余文字保留）。',
    '拿不准数据口径的（比如不知道这个数字是怎么算的、从哪筛的）标 confidence:"low" 并在 question 里写出要问用户的具体问题。',
    '表格：整表算一个形状，必须把【每一个】会变的数据格逐行逐格列全进 cells（r/c 从 0 计，表头行通常是静态不列）——有几行数据就列几行，绝不允许只列第一行当例子。每个 cell 也带 tmpl 保留原格的文字格式（如原格是"+7.7%"则 tmpl 为"+{v}%"，原格是"12,345"则 tmpl 为"{v}"）。',
    'dataDesc 必须写全过滤口径（产线/系列/国家等维度 + 期间），保证照着描述任何时候取数都是同一个口径。',
    '只输出 JSON 数组，不要任何其他文字：',
    '[{"slide":1,"shapeIdx":0,"kind":"static"},',
    ' {"slide":1,"shapeIdx":2,"kind":"data","dataDesc":"墨西哥平板2026年初至今累计SO(台),PSI渠道全加口径","tmpl":"累计SO：{v}台","confidence":"high"},',
    ' {"slide":2,"shapeIdx":0,"kind":"data","table":true,"cells":[{"r":1,"c":1,"dataDesc":"Slate系列2026累计SO(台)","tmpl":"{v}","confidence":"high"},{"r":1,"c":2,"dataDesc":"Slate系列SO同比(%)","tmpl":"+{v}%","confidence":"high"},{"r":2,"c":1,"dataDesc":"Coral系列2026累计SO(台)","tmpl":"{v}","confidence":"high"},{"r":2,"c":2,"dataDesc":"Coral系列SO同比(%)","tmpl":"+{v}%","confidence":"high"}],"confidence":"high"},',
    ' {"slide":1,"shapeIdx":3,"kind":"data","dataDesc":"不明比率","tmpl":"达成 {v}","confidence":"low","question":"第1页的『达成 87%』是什么达成率？分子分母各是什么？"}]',
  ].join('\n');

  async function learn(deps, struct, onFlow) {
    onFlow('📐 解析结构：' + struct.slides.length + ' 页、' + struct.slides.reduce((a, s) => a + s.shapes.length, 0) + ' 个形状');
    onFlow('🔎 逐形状识别数据字段…');
    const resp = await deps.chat({
      system: LEARN_SYS,
      messages: [{ role: 'user', content: describeStructure(struct) }],
      tools: [], maxTokens: 4000,
    });
    if (!resp || resp.error) return { error: '模型无响应: ' + ((resp && resp.error) || '') };
    const arr = pickJson(resp.content);
    if (!Array.isArray(arr)) return { error: '识别结果不是有效 JSON，请重试' };
    // 规整 + 挂 slideFile
    const bindings = arr.filter(b => b && b.kind).map((b, i) => {
      const sl = struct.slides[(+b.slide || 1) - 1];
      return Object.assign({ id: 'b' + i, slideFile: sl ? sl.file : '', slide: +b.slide || 1, shapeIdx: +b.shapeIdx || 0 }, b);
    }).filter(b => b.slideFile);
    completeTableCells(struct, bindings, onFlow);
    const dataN = bindings.filter(b => b.kind === 'data').length;
    const lowQ = bindings.filter(b => b.kind === 'data' && b.confidence === 'low' && b.question);
    onFlow('✅ 识别完成：' + dataN + ' 个数据字段（' + lowQ.length + ' 个待确认）');
    return { bindings, questions: lowQ };
  }

  /* 表格绑定确定性补全：模型常只列第一数据行当例子（提示词五令不止）——
     对已绑列，把绑定按行成员名复制到其余未绑的数据行，dataDesc 换行首名。 */
  function completeTableCells(struct, bindings, onFlow) {
    bindings.forEach(b => {
      if (b.kind !== 'data' || !b.table || !b.cells || !b.cells.length) return;
      const sl = struct.slides[(b.slide || 1) - 1];
      const shape = sl && sl.shapes[b.shapeIdx];
      if (!shape || shape.type !== 'table' || !shape.rows) return;
      const rows = shape.rows;
      const have = {};
      b.cells.forEach(c => { have[c.r + ',' + c.c] = true; });
      const added = [];
      // 已绑的每一列取一个样本，向其余数据行复制
      const byCol = {};
      b.cells.forEach(c => { if (!byCol[c.c]) byCol[c.c] = c; });
      Object.keys(byCol).forEach(cStr => {
        const col = +cStr, sample = byCol[cStr];
        const srcMember = String((rows[sample.r] && rows[sample.r][0]) || '').trim();
        for (let r = 1; r < rows.length; r++) {
          if (have[r + ',' + col]) continue;
          const cellTxt = String((rows[r] && rows[r][col]) || '').trim();
          const member = String((rows[r] && rows[r][0]) || '').trim();
          if (!cellTxt || !member) continue;           // 空格/无行首名不补
          let desc = String(sample.dataDesc || '');
          desc = (srcMember && desc.indexOf(srcMember) >= 0) ? desc.split(srcMember).join(member) : (desc + '（行成员：' + member + '）');
          b.cells.push({ r, c: col, dataDesc: desc, tmpl: sample.tmpl || '{v}', confidence: sample.confidence || 'high' });
          have[r + ',' + col] = true;
          added.push('(' + r + ',' + col + ')' + member);
        }
      });
      if (added.length && onFlow) onFlow('🧮 表格绑定补全：' + added.join(' '));
    });
  }

  async function refine(deps, bindings, userAnswer, onFlow) {
    onFlow('🔧 按你的说明修正绑定…');
    const resp = await deps.chat({
      system: '你是 PPT 模板分析师。下面是既有的绑定 JSON 与用户对疑问的解答。把用户的说明合并进对应绑定（更新 dataDesc、confidence 升为 high、删掉 question；用户说是静态的就改 kind:"static"）。只输出修正后的完整 JSON 数组，不要其他文字。',
      messages: [{ role: 'user', content: '【既有绑定】\n' + J(bindings) + '\n\n【用户解答】\n' + userAnswer }],
      tools: [], maxTokens: 4000,
    });
    if (!resp || resp.error) return { error: '模型无响应' };
    const arr = pickJson(resp.content);
    if (!Array.isArray(arr)) return { error: '修正结果解析失败，请重说一次' };
    return { bindings: arr };
  }

  // 绑定报告（sys 卡片文本）
  function report(bindings, questions) {
    const data = bindings.filter(b => b.kind === 'data');
    const L = ['🧩 模板绑定提案（' + data.length + ' 个数据字段）：'];
    data.forEach(b => {
      if (b.table && b.cells) {
        L.push('· 第' + b.slide + '页 表格[' + b.shapeIdx + ']：' + b.cells.length + ' 个数据格 — ' + b.cells.slice(0, 3).map(c => '(' + c.r + ',' + c.c + ')' + (c.dataDesc || '')).join('；') + (b.cells.length > 3 ? '…' : ''));
      } else {
        L.push('· 第' + b.slide + '页 [' + b.shapeIdx + '] ' + (b.confidence === 'low' ? '❓' : '✓') + ' ' + (b.dataDesc || '') + (b.tmpl ? '  「' + b.tmpl + '」' : ''));
      }
    });
    if (questions && questions.length) {
      L.push('');
      L.push('❓ 有 ' + questions.length + ' 个数据口径我拿不准，请直接回复解答（例：问题1 是财经收入，单位MUSD）：');
      questions.forEach((q, i) => L.push('  问题' + (i + 1) + '：' + q.question));
      L.push('答完我会更新提案；也可以直接说「保存模板 XXX」带着现状保存。');
    } else {
      L.push('');
      L.push('口径都清楚了。说「保存模板 XXX」即存为可刷新模板。');
    }
    return L.join('\n');
  }

  // 刷新：按绑定逐项取最新数据（复用编排链取数），返回 repls
  async function refresh(depsFactory, tplMeta, onFlow) {
    const data = (tplMeta.bindings || []).filter(b => b.kind === 'data');
    if (!data.length) return { error: '模板没有数据字段' };
    onFlow('🔄 按 ' + data.length + ' 个绑定取最新数据…');
    const items = [];
    data.forEach(b => {
      if (b.table && b.cells) b.cells.forEach((c, ci) => items.push({ key: b.id + '_' + ci, desc: c.dataDesc || '', tmpl: c.tmpl || '{v}', b, cell: c }));
      else items.push({ key: b.id, desc: b.dataDesc || '', tmpl: b.tmpl || '{v}', b });
    });
    const ask = '【模板刷新取数】对下面每个字段用工具查出最新值，严格按字段的口径描述取数；查不到的填 "(未取到)"。全部查完后，最终回复只输出一个 JSON（不要任何其他文字）：{"字段key":"填入的完整文本(把数值代入文字模板的{v})", ...}\n\n' +
      items.map(it => '· key=' + it.key + '  口径：' + it.desc + '  文字模板：' + it.tmpl).join('\n');
    /* 专用工具循环（不走 orchestrate——溯源门禁的 claims 格式指令会与「只输出 JSON」打架） */
    const deps = depsFactory();
    const names = ['meta', 'options', 'query', 'report', 'searchDim', 'rawRows', 'dataCatalog', 'financeOverview', 'financeCustom'].filter(n => deps.schemas && deps.schemas[n]);
    const specs = deps.buildToolSpecs ? deps.buildToolSpecs(names) : [];
    const sys = '你是数据填充员。用工具按每个字段的口径取数（维度取值先用 options/searchDim 核对精确写法），取不到如实填"(未取到)"。最终回复必须只有一个 JSON 对象，没有任何其他文字。';
    const messages = [{ role: 'user', content: ask }];
    let content = '';
    for (let round = 0; round < 8; round++) {
      const resp = await deps.chat({ system: sys, messages, tools: specs, maxTokens: 3000 });
      if (!resp || resp.error) return { error: '取数模型无响应: ' + ((resp && resp.error) || '') };
      const calls = [];
      (resp.toolCalls || []).forEach(tc => {
        const nm = tc.function ? tc.function.name : tc.name;
        let ag = {}; try { ag = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) {}
        if (names.indexOf(nm) >= 0) calls.push({ tool: nm, args: ag });
      });
      if (calls.length) {
        messages.push({ role: 'assistant', content: resp.content || '' });
        for (const c of calls) {
          onFlow('　🔧 ' + c.tool);
          let out2; try { out2 = await deps.runTool(c.tool, c.args); } catch (e) { out2 = { error: String(e) }; }
          messages.push({ role: 'user', content: '[工具 ' + c.tool + ' 返回] ' + J(out2).slice(0, 6000) + '\n\n数据够了就输出最终 JSON。' });
        }
        continue;
      }
      content = resp.content || '';
      break;
    }
    const map = pickJson(content);
    if (!map || typeof map !== 'object') return { error: '取数结果解析失败（模型未按 JSON 输出），请重试' };
    const repls = [];
    data.forEach(b => {
      if (b.table && b.cells) {
        const cells = b.cells.map((c, ci) => ({ r: c.r, c: c.c, text: String(map[b.id + '_' + ci] != null ? map[b.id + '_' + ci] : '(未取到)') }));
        repls.push({ slideFile: b.slideFile, shapeIdx: b.shapeIdx, cells });
      } else if (map[b.id] != null) {
        repls.push({ slideFile: b.slideFile, shapeIdx: b.shapeIdx, text: String(map[b.id]) });
      }
    });
    onFlow('✅ 取数完成：' + repls.length + ' 处将更新');
    return { repls, raw: map };
  }

  const api = { learn, refine, report, refresh, pickJson, describeStructure };
  if (typeof window !== 'undefined') window.PptTpl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
