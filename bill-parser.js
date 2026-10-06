/* 請款明細表（文中）PDF 讀取規則（M1 7.2）。純函式：輸入 pdf.js 取出的文字（含位置），輸出欄位與問題；不碰網路、不依賴平台。
 * 瀏覽器（手動匯入）與測試共用同一份。
 * 不靠「文字出現的順序」，靠位置與標籤：同一行（y 相近）的字依 x 排序、斷開成區段；
 * 項目列的欄位依「內容樣式」判斷（5 位數＝帳期、yyy-mm-dd＝日期、數字＝金額、其餘＝帳名），所以欄位順序或版面略有不同也能讀。
 * 輸入 pages：[{ items: [{ str, x, y, w }] }]，y 為由上往下的座標。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YcBillParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LINE_TOL = 2.5;     // 同一行的 y 容許差
  var SEG_GAP = 8;        // 超過這個間距就切成新區段
  var NEAR_Y = 6;         // 合計數字與標籤的 y 容許差（有些版面數字與標籤差幾個點）

  function squeeze(s) { return String(s).replace(/[\s　]+/g, ''); }
  function isNum(s) { return /^-?[\d,]+$/.test(s) && /\d/.test(s); }
  function toInt(s) { return parseInt(String(s).replace(/,/g, ''), 10); }
  function rocToIso(s) {
    var m = /^(\d{2,3})-(\d{2})-(\d{2})$/.exec(s);
    return m ? (1911 + parseInt(m[1], 10)) + '-' + m[2] + '-' + m[3] : '';
  }

  /** 一頁 → 行（每行含依 x 排序的區段） */
  function pageLines(items) {
    var groups = [];
    items.forEach(function (it) {
      if (!it.str || !String(it.str).trim()) return;
      var g = null;
      for (var i = 0; i < groups.length; i++) if (Math.abs(groups[i].y - it.y) < LINE_TOL) { g = groups[i]; break; }
      if (!g) { g = { y: it.y, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    groups.sort(function (a, b) { return a.y - b.y; });
    return groups.map(function (g) {
      g.items.sort(function (a, b) { return a.x - b.x; });
      var segs = [], prevEnd = null;
      g.items.forEach(function (it) {
        if (prevEnd === null || it.x - prevEnd > SEG_GAP) segs.push({ x: it.x, text: '' });
        segs[segs.length - 1].text += it.str;
        prevEnd = it.x + (it.w || 0);
      });
      return { y: g.y, segs: segs.map(function (s) { return { x: s.x, text: s.text.trim() }; }).filter(function (s) { return s.text; }) };
    });
  }

  /** 「標籤：值」；標籤內的空白不計（「名　　稱」＝「名稱」），標籤被切在兩個區段時也能接起來 */
  function labeled(line) {
    var out = {};
    var texts = line.segs.map(function (s) { return s.text; });
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i], k = squeeze(t);
      if (/^[^：:]{1,8}$/.test(k) && i + 1 < texts.length && /[：:]/.test(texts[i + 1].replace(/[^：:]/g, ''))) { t = t + texts[i + 1]; i++; }
      var m = /^([^：:]{1,12})[：:](.*)$/.exec(t);
      if (m) out[squeeze(m[1])] = m[2].trim();
    }
    return out;
  }

  /**
   * @returns {{ ok:boolean, code?:string, message?:string, bill?:Object, warnings:string[] }}
   * bill: { billingPeriod, taxId, name, issueDate, billNo, items:[{seq,label,amount,date,period}], total, due }
   */
  function parseBill(pages) {
    var warnings = [];
    var allLines = [];
    (pages || []).forEach(function (p, pi) { pageLines(p.items || []).forEach(function (l) { l.page = pi; allLines.push(l); }); });
    if (!allLines.length) return { ok: false, code: 'NO_TEXT', message: '讀不到文字（可能是掃描圖檔，不是電子 PDF）', warnings: warnings };
    var whole = allLines.map(function (l) { return squeeze(l.segs.map(function (s) { return s.text; }).join('')); }).join('\n');
    if (whole.indexOf('請款明細表') < 0) return { ok: false, code: 'NOT_BILL', message: '不是「請款明細表」', warnings: warnings };

    // ----- 欄位（帳期、統編、名稱、製表日期、請款單號） -----
    var f = {};
    allLines.forEach(function (l) { var o = labeled(l); Object.keys(o).forEach(function (k) { if (f[k] === undefined) f[k] = o[k]; }); });
    var period = squeeze(f['帳期(年月)'] || f['帳期（年月）'] || '');
    var taxId = squeeze(f['統一編號'] || '');
    if (!/^\d{1,8}$/.test(taxId)) return { ok: false, code: 'NO_TAXID', message: '讀不到統一編號', warnings: warnings };
    while (taxId.length < 8) taxId = '0' + taxId; // 補足前導 0
    var name = (f['名稱'] || '').replace(/[\s　]+/g, '');
    var issueRoc = squeeze(f['製表日期'] || '');
    var billNo = squeeze(f['請款單號'] || '');

    // ----- 項目列：表頭（同一行同時有 帳期、日期、帳名、金額）之下，到「合計」之前 -----
    var items = [], total = null, due = null, headerSeen = false, ended = false;
    var labelPos = { total: [], due: [] };
    allLines.forEach(function (l) {
      var texts = l.segs.map(function (s) { return squeeze(s.text); });
      var isHeader = ['帳期', '日期', '帳名', '金額'].every(function (h) { return texts.indexOf(h) >= 0; });
      if (isHeader) { headerSeen = true; ended = false; return; }
      // 標籤文字（不含數字區段）；「合 計」可能被切成「合」「計：」兩段，所以先把非數字區段接起來再比對
      var labelText = squeeze(l.segs.filter(function (s) { return !isNum(squeeze(s.text)); }).map(function (s) { return s.text; }).join(''));
      var firstX = l.segs.length ? l.segs[0].x : 0;
      if (/^合計[：:]?$/.test(labelText)) labelPos.total.push({ x: firstX, y: l.y, page: l.page });
      if (/^本期應收金額[：:]?$/.test(labelText)) labelPos.due.push({ x: firstX, y: l.y, page: l.page });
      if (!headerSeen || ended) return;
      if (/^合計|^本期應收金額/.test(labelText)) { ended = true; return; }
      var row = { period: '', date: '', label: '', amount: null };
      var nums = [];
      l.segs.forEach(function (s) {
        var t = s.text.replace(/[\s　]+/g, ' ').trim(), k = squeeze(t);
        if (/^\d{5}$/.test(k) && !row.period) row.period = k;
        else if (/^\d{2,3}-\d{2}-\d{2}$/.test(k)) row.date = k;
        else if (isNum(k)) nums.push(k);
        else row.label = row.label ? row.label + t : t;
      });
      if (nums.length) row.amount = toInt(nums[nums.length - 1]);
      if (!row.label && !row.period && !row.date) return; // 只有一個數字的列（有些版面把合計數字放在「合計」上一行）
      if (row.label && row.amount !== null) items.push({ seq: items.length + 1, label: row.label, amount: row.amount, date: rocToIso(row.date), period: row.period });
      else if (row.label || row.amount !== null) warnings.push('有一列無法完整讀取：' + (row.label || '（無帳名）'));
    });

    // 合計／本期應收金額：在標籤右邊、y 相近的數字
    function valueNear(pos) {
      var best = null;
      allLines.forEach(function (l) {
        if (l.page !== pos.page || Math.abs(l.y - pos.y) > NEAR_Y) return;
        l.segs.forEach(function (s) {
          var k = squeeze(s.text);
          if (isNum(k) && s.x > pos.x && (!best || Math.abs(l.y - pos.y) < best.dy)) best = { v: toInt(k), dy: Math.abs(l.y - pos.y) };
        });
      });
      return best ? best.v : null;
    }
    if (labelPos.total.length) total = valueNear(labelPos.total[labelPos.total.length - 1]);
    if (labelPos.due.length) due = valueNear(labelPos.due[labelPos.due.length - 1]);

    if (!/^\d{5}$/.test(period)) {
      // 有些版面沒有「帳期(年月)」欄位：改用項目列的帳期（全部相同才採用）
      var ps = {}; items.forEach(function (i) { if (i.period) ps[i.period] = 1; });
      var keys = Object.keys(ps);
      if (keys.length === 1) { period = keys[0]; warnings.push('帳期取自項目列（版面沒有「帳期(年月)」欄位）'); }
      else if (headerSeen) return { ok: false, code: 'NO_PERIOD', message: '讀不到帳期（年月）', warnings: warnings };
    }
    if (!headerSeen) return { ok: false, code: 'NO_TABLE', message: '找不到項目表格（版面可能改了）', warnings: warnings };
    if (!items.length) return { ok: false, code: 'NO_ITEMS', message: '讀不到任何請款項目', warnings: warnings };
    if (total === null) return { ok: false, code: 'NO_TOTAL', message: '讀不到「合計」', warnings: warnings };
    if (due === null) return { ok: false, code: 'NO_DUE', message: '讀不到「本期應收金額」', warnings: warnings };
    return {
      ok: true, warnings: warnings,
      bill: { billingPeriod: period, taxId: taxId, name: name, issueDate: rocToIso(issueRoc), billNo: billNo, items: items, total: total, due: due }
    };
  }

  /** 檔名「{帳期}_{統編}…」→ { period, taxId }；不符回 null（檢查 B4 用） */
  function parseFileName(fileName) {
    var m = /^(\d{5})_(\d{1,8})(?:_|\.|$)/.exec(String(fileName || ''));
    if (!m) return null;
    var id = m[2]; while (id.length < 8) id = '0' + id;
    return { period: m[1], taxId: id };
  }

  return { parseBill: parseBill, parseFileName: parseFileName, pageLines: pageLines };
});
