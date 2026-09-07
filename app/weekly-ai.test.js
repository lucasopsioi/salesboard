// app/weekly-ai.test.js — 周报 AI 叙述：事实清单 / 提示词 / 编数校验
const A = require('./weekly-ai.js');
let f = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && d !== undefined ? '  << ' + JSON.stringify(d) : '')); if (!c) f++; };

// 假的芯片解析器：按 id 返回值，'—' 代表算不出
const WC = {
  chipLabel: cfg => ({ week: '当前周号', wow: 'WoW%', soYoy: 'SO同比(YTD)', dos: '渠道DOS', topRise: 'WoW涨幅最大', dead: '没数的' }[cfg.id] || cfg.id),
  resolveChip: cfg => ({ week: 'W34', wow: '-8%', soYoy: '+30%', dos: '45', topRise: '墨西哥', dead: '—' }[cfg.id]),
};
const palette = [{ cfg: { id: 'week' } }, { cfg: { id: 'wow' } }, { cfg: { id: 'soYoy' } }, { cfg: { id: 'dos' } }, { cfg: { id: 'topRise' } }, { cfg: { id: 'dead' } }];

// —— 事实清单 ——
const facts = A.factsFrom(palette, {}, WC);
ok('F1 解析出全部有数芯片', facts.length === 5, facts);
ok('F2 算不出的芯片被丢掉(不喂「无数据」诱导模型编)', !facts.some(x => x.label === '没数的'));
ok('F3 标签与值成对', facts[1].label === 'WoW%' && facts[1].value === '-8%', facts[1]);
ok('F4 同标签同值去重', A.factsFrom(palette.concat([{ cfg: { id: 'wow' } }]), {}, WC).length === 5);
ok('F5 空料架给空清单', A.factsFrom([], {}, WC).length === 0);

// —— 提示词 ——
const msgs = A.buildMessages({ facts, style: '大区整体销售：W30 WoW +5%，SO同比 +12%。', scopeLabel: '产业整体' });
ok('P1 system 含「只能使用」铁律', /只能使用/.test(msgs[0].content));
ok('P2 明确禁止自行计算换算', /严禁自己计算|换算/.test(msgs[0].content));
ok('P3 事实清单进了 user 消息', /WoW%：-8%/.test(msgs[1].content), msgs[1].content.slice(0, 200));
ok('P4 文风样例进了 user 消息且注明只学写法', /文风样例/.test(msgs[1].content) && /不要搬里面的数字/.test(msgs[1].content));
ok('P5 范围写明', /产业整体/.test(msgs[1].content));
const msgs2 = A.buildMessages({ facts, style: '', scopeLabel: '按系列' });
ok('P6 没有文风样例时不出现该段', !/文风样例/.test(msgs2[1].content));

// —— 编数校验 ——
ok('V1 只用清单里的数 → 通过', A.verifyNumbers('W34 WoW -8%，SO同比 +30%，渠道DOS 45 天。', facts).ok);
ok('V2 出现清单外的数 → 抓出来', (() => { const v = A.verifyNumbers('本周卖了 12345 台。', facts); return !v.ok && v.unknown.indexOf('12345') >= 0; })());
ok('V3 周号/连续N周这类小整数不误伤', A.verifyNumbers('连续 4 周下滑，第 34 周。', facts).ok);
ok('V4 千分位与负号归一后能匹配', A.verifyNumbers('DOS 为 45 天，WoW -8%。', facts).ok);
ok('V5 numsIn 抽数正确', JSON.stringify(A.numsIn('a -1,234.5 b 7%')) === JSON.stringify(['1234.5', '7']), A.numsIn('a -1,234.5 b 7%'));

// —— 生成（注入假 chat）——
(async () => {
  const good = await A.generate({ facts, style: '', scopeLabel: '产业整体', chat: async () => ({ content: '```\n根据数据，W34 WoW -8%，SO同比 +30%。\n```' }) });
  ok('G1 去掉代码围栏与「根据数据」前缀', good.text === 'W34 WoW -8%，SO同比 +30%。', good.text);
  ok('G2 附带校验结果', good.verify && good.verify.ok === true);
  const bad = await A.generate({ facts, style: '', scopeLabel: '产业整体', chat: async () => ({ content: '本周售出 98765 台，创新高。' }) });
  ok('G3 编出来的数被标记', bad.verify && bad.verify.ok === false && bad.verify.unknown.indexOf('98765') >= 0, bad.verify);
  const err = await A.generate({ facts, style: '', chat: async () => ({ error: '连不上' }) });
  ok('G4 模型报错如实返回', err.error === '连不上');
  const empty = await A.generate({ facts: [], chat: async () => ({ content: 'x' }) });
  ok('G5 无数据时不调模型直接提示', /没有可用数据/.test(empty.error || ''));
  const blank = await A.generate({ facts, chat: async () => ({ content: '   ' }) });
  ok('G6 模型返空给可读提示', /为空/.test(blank.error || ''));
  console.log(f ? (f + ' FAILED') : 'ALL PASS');
  process.exit(f ? 1 : 0);
})();
