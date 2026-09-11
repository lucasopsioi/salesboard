const C = require('./roadmap-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

// ---- validateLaunch ----
ok('validateLaunch empty -> productId+country', (() => {
  const e = C.validateLaunch({}); return e.length === 2 && e.indexOf('productId') >= 0 && e.indexOf('country') >= 0;
})());
ok('validateLaunch missing country', C.validateLaunch({ productId: 'p1' }).join() === 'country');
ok('validateLaunch missing productId', C.validateLaunch({ country: '墨西哥' }).join() === 'productId');
ok('validateLaunch full ok', C.validateLaunch({ productId: 'p1', country: '墨西哥' }).length === 0);
ok('validateLaunch dates free (no format check)', C.validateLaunch({ productId: 'p1', country: '墨西哥', presaleDate: '随便', onlineDate: 'xx' }).length === 0);
ok('validateLaunch blank strings count as missing', C.validateLaunch({ productId: '  ', country: '' }).length === 2);
ok('validateLaunch null-safe', C.validateLaunch(null).length === 2);

// ---- validateBattle ----
ok('validateBattle empty -> 3 missing', (() => {
  const e = C.validateBattle({}); return e.length === 3 && e.indexOf('productId') >= 0 && e.indexOf('country') >= 0 && e.indexOf('rival') >= 0;
})());
ok('validateBattle missing rival', C.validateBattle({ productId: 'p1', country: '墨西哥' }).join() === 'rival');
ok('validateBattle full ok', C.validateBattle({ productId: 'p1', country: '墨西哥', rival: 'AirPods' }).length === 0);
ok('validateBattle blank rival missing', C.validateBattle({ productId: 'p1', country: '墨西哥', rival: '   ' }).join() === 'rival');
ok('validateBattle null-safe', C.validateBattle(null).length === 3);

// ---- exportAoa backward compat (2-arg) ----
const prod = { id: 'pA', name: 'SonicClip 2', internalCode: 'Strix-T02', seriesGroup: '开放式耳机', skus: [], pricing: [] };
const ex2 = C.exportAoa([prod]);
ok('exportAoa 2-arg same sheet keys', (() => {
  const keys = Object.keys(ex2).sort().join(',');
  return keys === ['产品总表', 'SKU明细', '分国定价', '配件', '卖点与备注', '样机'].sort().join(',');
})());
ok('exportAoa 2-arg NO 上市计划 sheet', !('上市计划' in ex2));
ok('exportAoa 2-arg NO 竞品对标 sheet', !('竞品对标' in ex2));
const ex2b = C.exportAoa([prod], []);
ok('exportAoa 2-arg (empty samples) no new sheets', !('上市计划' in ex2b) && !('竞品对标' in ex2b));
const ex4empty = C.exportAoa([prod], [], [], []);
ok('exportAoa empty launch/battle -> no new sheets', !('上市计划' in ex4empty) && !('竞品对标' in ex4empty));

// ---- exportAoa 4-arg: 上市计划 ----
const LAUNCH_HDR = ['产品', '国家', '预售时间', '线上首销', '线下首销', '整体首销', '首销名义台数', '生命周期目标', 'AATP预计', '主力渠道', '首销毛利率', '首销Offer', '备注'];
const BATTLE_HDR = ['产品', '国家', '竞品', '价格(本币)'];
const launch = [{ id: 'l1', productId: 'pA', country: '墨西哥', presaleDate: '2026/07', onlineDate: '2026/08', offlineDate: '2026/08', overallDate: '2026/08', firstTarget: 5000, lifecycleTarget: 50000, aatpEst: '3000', channel: '电商', firstGm: '25%', firstOffer: '首销9折', note: '备注X' }];
const battle = [{ id: 'b1', productId: 'pA', country: '墨西哥', rival: 'AirPods', priceLocal: 3999 }];
const ex4 = C.exportAoa([prod], [], launch, battle);
ok('exportAoa 4-arg has 上市计划', Array.isArray(ex4['上市计划']));
ok('exportAoa 4-arg has 竞品对标', Array.isArray(ex4['竞品对标']));
ok('exportAoa 上市计划 header exact', JSON.stringify(ex4['上市计划'][0]) === JSON.stringify(LAUNCH_HDR));
ok('exportAoa 竞品对标 header exact', JSON.stringify(ex4['竞品对标'][0]) === JSON.stringify(BATTLE_HDR));
ok('exportAoa 上市计划 rows', ex4['上市计划'].length === 2);
ok('exportAoa 竞品对标 rows', ex4['竞品对标'].length === 2);
ok('exportAoa 上市计划 productId->name', ex4['上市计划'][1][0] === 'SonicClip 2');
ok('exportAoa 上市计划 country', ex4['上市计划'][1][1] === '墨西哥');
ok('exportAoa 上市计划 note tail', ex4['上市计划'][1][12] === '备注X');
ok('exportAoa 上市计划 firstTarget', ex4['上市计划'][1][6] === 5000);
ok('exportAoa 竞品对标 productId->name', ex4['竞品对标'][1][0] === 'SonicClip 2');
ok('exportAoa 竞品对标 rival', ex4['竞品对标'][1][2] === 'AirPods');
ok('exportAoa 竞品对标 priceLocal', ex4['竞品对标'][1][3] === 3999);

// missing productId -> name '' (unknown product)
const ex4miss = C.exportAoa([prod], [], [{ id: 'l2', productId: '__none__', country: '智利' }], [{ id: 'b2', productId: '__none__', country: '智利', rival: 'X' }]);
ok('exportAoa 上市计划 unknown product name ->', ex4miss['上市计划'][1][0] === '');
ok('exportAoa 上市计划 missing fields -> empty string', ex4miss['上市计划'][1][6] === '');
ok('exportAoa 竞品对标 unknown product name ->', ex4miss['竞品对标'][1][0] === '');

// only launch provided (battle empty) -> only 上市计划 added
const exL = C.exportAoa([prod], [], launch, []);
ok('exportAoa only-launch adds 上市计划 only', ('上市计划' in exL) && !('竞品对标' in exL));
const exB = C.exportAoa([prod], [], [], battle);
ok('exportAoa only-battle adds 竞品对标 only', !('上市计划' in exB) && ('竞品对标' in exB));

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);
