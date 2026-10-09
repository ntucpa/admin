/*
 * 收款對帳比對規則（M2 第五章，規則 A～F、代繳稅款）：在管理員的瀏覽器內執行，銀行交易不上傳、不存雲端（業主 2026-10-09 決定）。
 * 純函式（UMD）：後台網頁與伺服器端自動測試共用同一份。輸入皆為一般物件；金額為整數（元）；日期為毫秒。不修改輸入。
 * 約定：每筆交易的 allocations[].allocated 合計＝交易金額；allocations[].fee＝該張請款單因此「免收」的匯費（請款單剩餘金額 − 分配金額，僅在容許範圍內）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YcMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_SETTINGS = { fee: 30, splitDays: 14, comboMax: 3, autoConfirm: true, nameMinChars: 4, splitMax: 6 };
  var DAY = 86400000;

  function payerKey(t) { return String(t.payerAccount || t.payerName || '').trim(); }

  // 5.1 付款人辨識：先看匯款來源對照（帳號、戶名、標註），沒有再用戶名與公司名稱／簡稱比對
  function buildResolver(companies, aliases) {
    var byValue = {}, feeHabit = {};
    aliases.forEach(function (a) {
      if (a.status && a.status !== 'ACTIVE') return;
      if (a.type === 'FEE_HABIT') { feeHabit[a.companyId] = Number(a.value); return; }
      var k = a.type + '|' + String(a.value).trim();
      (byValue[k] = byValue[k] || {})[a.companyId] = 1;
    });
    var list = companies.map(function (c) { return { id: c.companyId, name: c.name || '', short: c.shortName || '' }; });
    return {
      feeHabit: feeHabit,
      resolve: function (t, minChars) {
        var ids = {};
        function add(type, v) { var s = v && byValue[type + '|' + String(v).trim()]; if (s) Object.keys(s).forEach(function (id) { ids[id] = 1; }); }
        add('ACCOUNT', t.payerAccount); add('NAME', t.payerName); add('TAG', t.payerTag);
        if (Object.keys(ids).length) return { companyIds: ids, known: true };
        var nm = String(t.payerName || '').trim();
        if (nm) list.forEach(function (c) {
          if ((nm.length >= minChars && c.name && c.name.indexOf(nm) === 0) || (c.short && nm.indexOf(c.short) >= 0)) ids[c.id] = 1;
        });
        return { companyIds: ids, known: false };
      }
    };
  }

  function feeOk(diff, tol, habit) { return (diff >= 1 && diff <= tol) || (habit != null && habit > 0 && diff === habit); }

  /**
   * @param {Array} txns   { id, amount, date, payerAccount, payerName, payerTag }  客戶收款（正數）
   * @param {Array} bills  { billId, companyId, amount }  待收請款單（amount＝尚應收的剩餘金額）
   * @param {Array} companies { companyId, name, shortName }
   * @param {Array} aliases   { companyId, type, value, status }
   * @param {Object} settings { fee, splitDays, comboMax, autoConfirm }
   * @returns {Array} 與 txns 同順序：{ txnId, status:'CONFIRMED'|'PROPOSED'|'UNMATCHED', rule, known, allocations:[{billId, companyId, allocated, fee}] }
   */
  function matchPayments(txns, bills, companies, aliases, settings) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var R = buildResolver(companies, aliases);
    // 工作用的請款單（不修改輸入）：amount＝目前剩餘待收。被「確認或建議」分配過的會扣掉，所以同一張請款單可被多筆交易分次分配
    // （例如客戶先匯兩筆 30,000 湊不齊 94,466：兩筆都先建議為部分收款），但已收滿的不會再被分配。
    var work = bills.map(function (b) { return { billId: b.billId, companyId: b.companyId, amount: b.amount, orig: b.amount }; });
    var byId = {}; work.forEach(function (b) { byId[b.billId] = b; });
    var billsByCompany = {}, billsByAmount = {};
    work.forEach(function (b) {
      (billsByCompany[b.companyId] = billsByCompany[b.companyId] || []).push(b);
      (billsByAmount[b.orig] = billsByAmount[b.orig] || []).push(b);
    });
    var resolved = txns.map(function (t) { return { t: t, p: R.resolve(t, s.nameMinChars) }; });
    var results = {};
    function free(b) { return b.amount > 0; }
    function take(allocs) { allocs.forEach(function (a) { byId[a.billId].amount -= a.allocated + a.fee; }); }
    function done(t, status, rule, known, allocs) {
      take(allocs);
      results[t.id] = { txnId: t.id, status: status, rule: rule, known: known, allocations: allocs };
    }
    // 已知對照且唯一候選才自動確認（5.2：多候選一律建議）
    function decide(known, single) { return known && single && s.autoConfirm ? 'CONFIRMED' : 'PROPOSED'; }
    function candBills(ids) { var out = []; Object.keys(ids).forEach(function (id) { (billsByCompany[id] || []).forEach(function (b) { if (free(b)) out.push(b); }); }); return out; }

    var byPayer = {};
    resolved.forEach(function (r) { var k = payerKey(r.t); if (!k) return; (byPayer[k] = byPayer[k] || []).push(r.t); });

    resolved.forEach(function (r) {
      var t = r.t, p = r.p;
      if (results[t.id]) return; // 已被前面某筆的分次加總（C）帶走
      var cids = Object.keys(p.companyIds), single = cids.length === 1;
      var cb = candBills(p.companyIds), m;
      // A 完全相符
      m = cb.filter(function (b) { return b.amount === t.amount; });
      if (m.length === 1) { done(t, decide(p.known, single), 'A', p.known, [{ billId: m[0].billId, companyId: m[0].companyId, allocated: t.amount, fee: 0 }]); return; }
      if (m.length > 1) { done(t, 'PROPOSED', 'A', p.known, [{ billId: m[0].billId, companyId: m[0].companyId, allocated: t.amount, fee: 0 }]); return; }
      // B 匯費容許（差額 1～容許，或等於該公司慣扣匯費）
      m = cb.filter(function (b) { return feeOk(b.amount - t.amount, s.fee, R.feeHabit[b.companyId]); });
      if (m.length === 1) { var bb = m[0]; done(t, decide(p.known, single), 'B', p.known, [{ billId: bb.billId, companyId: bb.companyId, allocated: t.amount, fee: bb.amount - t.amount }]); return; }
      // C 分次加總：同付款人、時間窗內，2～splitMax 筆合計等於某張請款單（容許匯費上限 × 筆數）
      if (cids.length && cb.length) {
        var peers = (byPayer[payerKey(t)] || []).filter(function (x) { return x.id !== t.id && !results[x.id] && Math.abs(x.date - t.date) <= s.splitDays * DAY; })
          .sort(function (a, b) { return Math.abs(a.date - t.date) - Math.abs(b.date - t.date); }).slice(0, 9);
        var hit = null;
        for (var i = 0; i < cb.length && !hit; i++) {
          var sub = findSubset(t, peers, cb[i].amount, s.fee, s.splitMax);
          if (sub) hit = { b: cb[i], set: sub };
        }
        if (hit) {
          var total = hit.set.reduce(function (a, x) { return a + x.amount; }, 0), target = hit.b.amount;
          // 合計剛好等於請款單（沒有差匯費）、付款人已知且只對到一家公司 → 視同完全相符（預設打勾，仍需按「送出」；業主 2026-10-09 決定）；有差匯費或付款人靠名稱猜的仍是建議
          var stC = target === total ? decide(p.known, single) : 'PROPOSED';
          hit.set.forEach(function (x, idx) {
            var last = idx === hit.set.length - 1;
            var alloc = [{ billId: hit.b.billId, companyId: hit.b.companyId, allocated: x.amount, fee: last ? target - total : 0 }];
            if (x === t) done(t, stC, 'C', p.known, alloc);
            else { take(alloc); results[x.id] = { txnId: x.id, status: stC, rule: 'C', known: p.known, allocations: alloc }; }
          });
          return;
        }
      }
      // D 一筆多張（2～comboMax 張候選請款單合計，容許匯費上限 × 張數）
      if (cb.length >= 2) {
        var pool = cb.length > 12 ? cb.slice(0, 12) : cb;
        var combo = findCombo(pool, t.amount, s.comboMax, s.fee);
        if (combo) {
          var remain = t.amount, allocs = combo.map(function (b, idx) {
            var last = idx === combo.length - 1, a = last ? remain : Math.min(b.amount, remain - 1);
            remain -= a;
            return { billId: b.billId, companyId: b.companyId, allocated: a, fee: b.amount - a };
          });
          done(t, 'PROPOSED', 'D', p.known, allocs);
          return;
        }
      }
      // E 只憑金額（付款人未知；全部請款單中恰一張金額相符）
      if (!cids.length) {
        m = (billsByAmount[t.amount] || []).filter(function (b) { return b.amount === t.amount; });
        if (m.length === 1) { done(t, 'PROPOSED', 'E', false, [{ billId: m[0].billId, companyId: m[0].companyId, allocated: t.amount, fee: 0 }]); return; }
      }
      // F 金額不符：已知對照、候選公司恰有一張待收請款單（確認後該張成為部分收款或差額）
      if (p.known && cb.length === 1) { done(t, 'PROPOSED', 'F', true, [{ billId: cb[0].billId, companyId: cb[0].companyId, allocated: t.amount, fee: 0 }]); return; }
      results[t.id] = { txnId: t.id, status: 'UNMATCHED', rule: null, known: p.known, allocations: [] };
    });
    return txns.map(function (t) { return results[t.id]; });
  }

  /** 含 t 在內、2～max 筆交易，合計落在 [target − fee×筆數, target]；先找筆數少的 */
  function findSubset(t, peers, target, fee, max) {
    var n = peers.length, limit = Math.min(max, n + 1);
    function pick(start, k, sum, acc) {
      if (k === 0) { var d = target - sum; return d >= 0 && d <= fee * (acc.length + 1) ? acc.slice() : null; }
      for (var i = start; i < n; i++) {
        if (sum + peers[i].amount > target) continue;
        acc.push(peers[i]);
        var r = pick(i + 1, k - 1, sum + peers[i].amount, acc);
        acc.pop();
        if (r) return r;
      }
      return null;
    }
    for (var size = 2; size <= limit; size++) {
      if (t.amount > target) return null;
      var r = pick(0, size - 1, t.amount, []);
      if (r) return [t].concat(r);
    }
    return null;
  }

  // 找 2～max 張請款單，合計與交易金額相符（容許匯費上限 × 張數）
  function findCombo(pool, amount, max, fee) {
    var n = pool.length;
    function pick(start, k, sum, acc) {
      if (k === 0) { var d = sum - amount; return d >= 0 && d <= fee * acc.length ? acc.slice() : null; }
      for (var i = start; i < n; i++) {
        acc.push(pool[i]);
        var r = pick(i + 1, k - 1, sum + pool[i].amount, acc);
        acc.pop();
        if (r) return r;
      }
      return null;
    }
    for (var k = 2; k <= max; k++) { var r = pick(0, k, 0, []); if (r) return r; }
    return null;
  }

  /**
   * 5.3 代繳稅款比對：繳費轉出的銷帳編號（7 碼）＝統編後 7 碼，且金額＝該期應納稅額，恰一筆→自動確認；多筆→建議。
   * txns：{ id, amount（正數）, refNo7, kind:'VAT'|'PREPAY' }；filings：{ filingId, companyId, taxAmount, periodKey }（尚未繳稅者）
   * 暫繳（PREPAY）目前沒有對應的檢核列，只顯示（status:'INFO'）。
   */
  function matchTaxPayments(txns, filings) {
    var taken = {};
    return txns.map(function (t) {
      if (t.kind !== 'VAT') return { txnId: t.id, status: 'INFO', rule: null, allocations: [], note: '暫繳尚無對應的檢核列，只顯示' };
      var byCompany = filings.filter(function (f) { return t.refNo7 && String(f.companyId).slice(-7) === t.refNo7; });
      var m = byCompany.filter(function (f) { return f.taxAmount === t.amount && !taken[f.filingId]; });
      if (m.length >= 1) {
        taken[m[0].filingId] = 1;
        return { txnId: t.id, status: m.length === 1 ? 'CONFIRMED' : 'PROPOSED', rule: 'TAX_REF', allocations: [{ filingId: m[0].filingId, companyId: m[0].companyId, allocated: t.amount, fee: 0 }], note: m[0].periodKey };
      }
      return { txnId: t.id, status: 'UNMATCHED', rule: null, allocations: [], note: byCompany.length ? '金額與該期應納稅額不符' : '找不到銷帳編號對應的公司' };
    });
  }

  return { matchPayments: matchPayments, matchTaxPayments: matchTaxPayments, DEFAULT_SETTINGS: DEFAULT_SETTINGS };
});
