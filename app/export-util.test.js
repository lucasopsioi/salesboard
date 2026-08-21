const E = require('./export-util.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
ok('ymd 8 digits', /^\d{8}$/.test(E.ymd()));
ok('ymd month padded', E.ymd().slice(4, 6) === String(new Date().getMonth() + 1).padStart(2, '0'));
ok('safe strips illegal', E.safe('a/b:c*d?e"f<g>h|i\\j') === 'a_b_c_d_e_f_g_h_i_j');
ok('safe null', E.safe(null) === '');
ok('api shape', typeof E.saveXlsx === 'function' && typeof E.savePptxTables === 'function');
console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);
