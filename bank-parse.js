/*
 * 台新銀行交易明細讀取規則（M2 第三、四章）：在管理員的瀏覽器內執行，銀行交易不上傳、不存雲端（業主 2026-10-09 決定）。
 * 純函式（UMD）：後台網頁與伺服器端自動測試共用同一份。輸入是 SheetJS 讀出的二維陣列（每列一個陣列）。
 * 餘額欄一律不讀、不保留；只留客戶收款（存入）與「繳費轉出」（代繳稅款），其他支出不保留（M2 3.3）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YcBank = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BAD_FORMAT = '檔案格式不符（請確認為台新交易明細）';
  var DEFAULT_KEYWORDS = ['股息', '存款息', '利息'];
  var DEFAULT_CATEGORIES = { 15252: { kind: 'VAT' }, 15254: { kind: 'VAT' }, 15031: { kind: 'PREPAY' }, 15010: { kind: 'OTHER_TAX' } };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function cellText(v) {
    if (v == null) return '';
    if (v instanceof Date) return v.getFullYear() + '/' + pad2(v.getMonth() + 1) + '/' + pad2(v.getDate()) + ' ' + pad2(v.getHours()) + ':' + pad2(v.getMinutes()) + ':' + pad2(v.getSeconds());
    return String(v).trim();
  }
  function toAmount(v) {
    if (typeof v === 'number') return Math.round(v);
    var s = String(v == null ? '' : v).replace(/[,\s　]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Math.round(Number(s));
  }

  /**
   * 讀整份明細。回傳 { ok, message, txns:[{ dt, post, summary, amount, memo }], stats:{ rows, kept, skipped } }
   * txns 只含存入與「繳費轉出」；金額為整數（元），存入為正、支出為負（繳費轉出為負）。
   */
  function readStatement(rows) {
    if (!Array.isArray(rows)) return { ok: false, message: BAD_FORMAT };
    var head = -1, col = {};
    for (var i = 0; i < Math.min(rows.length, 6); i++) {
      var cells = (rows[i] || []).map(cellText);
      if (cells.indexOf('交易日') >= 0 && cells.indexOf('摘要') >= 0 && cells.indexOf('金額') >= 0 && cells.indexOf('備註') >= 0) {
        head = i; col = { dt: cells.indexOf('交易日'), post: cells.indexOf('帳務日'), summary: cells.indexOf('摘要'), amount: cells.indexOf('金額'), memo: cells.indexOf('備註') };
        break;
      }
    }
    if (head < 0) return { ok: false, message: BAD_FORMAT };
    var txns = [], total = 0, skipped = 0;
    for (var r = head + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var dt = cellText(row[col.dt]);
      if (!dt || /^共\s*\d+/.test(dt)) continue; // 空列與「共 N 筆資料」
      if (!/^\d{4}\/\d{2}\/\d{2}/.test(dt)) return { ok: false, message: BAD_FORMAT };
      var amount = toAmount(row[col.amount]);
      if (amount == null) return { ok: false, message: BAD_FORMAT };
      total++;
      var summary = cellText(row[col.summary]);
      if (amount > 0 || summary === '繳費轉出') {
        txns.push({ dt: dt, post: col.post >= 0 ? cellText(row[col.post]) : '', summary: summary, amount: amount, memo: cellText(row[col.memo]) });
      } else skipped++;
    }
    return { ok: true, txns: txns, stats: { rows: total, kept: txns.length, skipped: skipped } };
  }

  /**
   * 解析備註（M2 4.1）。回傳 { payerAccount, payerName, freeText, payerTag, taxRefNo7, taxPayCategory }
   *  ATM 轉入「ATM 822-0000163540288782 自由文字 未歸類 標註」：帳號＝822-0000163540288782；自由文字不當戶名（常是備註，如「會計 0708」）
   *  轉帳存入「戶名  分行  交易序號 未歸類 標註」或「戶名 未歸類 標註」：只取戶名（序號不是帳號）
   *  轉帳存入「轉出0021090100204580 自由文字」：帳號＝0021090100204580
   *  繳費轉出「客戶銷帳編號:2501265 … 繳費類別:15252」
   */
  function parseMemo(summary, memo) {
    var out = { payerAccount: '', payerName: '', freeText: '', payerTag: '', taxRefNo7: '', taxPayCategory: '' };
    var text = String(memo == null ? '' : memo);
    var t = /未歸類[\s　]*([^\s　]+)/.exec(text);
    if (t) out.payerTag = t[1];
    var body = text.replace(/[\s　]*未歸類[\s　]*[^\s　]+[\s　]*$/, '').trim();
    if (summary === '繳費轉出') {
      var ref = /客戶銷帳編號[:：]\s*(\d{7})/.exec(text), cat = /繳費類別[:：]\s*(\d+)/.exec(text);
      if (ref) out.taxRefNo7 = ref[1];
      if (cat) out.taxPayCategory = cat[1];
      return out;
    }
    var atm = /^ATM[\s　]+(\d{3})-(\d+)[\s　]*(.*)$/.exec(body);
    if (atm) { out.payerAccount = atm[1] + '-' + atm[2]; out.freeText = atm[3].trim(); return out; }
    var from = /^轉出(\d+)[\s　]*(.*)$/.exec(body);
    if (from) { out.payerAccount = from[1]; out.freeText = from[2].trim(); return out; }
    if (summary === '轉帳存入') {
      var named = /^(.+?)[\s　]{2,}(.+?)[\s　]{2,}(\d{6,})$/.exec(body);
      // 末段 10 碼數字是銀行的交易序號（實測 41 筆全不相同、隨時間遞增），不是轉出帳號：不當帳號存（業主 2026-10-09 指出）
      if (named) { out.payerName = named[1].trim(); return out; }
      if (body && !/^\d+$/.test(body)) out.payerName = body;
    }
    return out;
  }

  /** 分類（M2 4.2）：TAX_PAYMENT 代繳營業稅／暫繳、OTHER_TAX_PAYMENT 其他代繳稅款、NON_CUSTOMER 非客戶款項、CUSTOMER_PAYMENT 客戶收款 */
  function classify(tx, opts) {
    var o = opts || {}, keywords = o.keywords || DEFAULT_KEYWORDS, cats = o.categories || DEFAULT_CATEGORIES;
    var p = parseMemo(tx.summary, tx.memo);
    if (tx.summary === '繳費轉出') {
      var c = p.taxPayCategory && cats[p.taxPayCategory];
      return p.taxRefNo7 && c && (c.kind === 'VAT' || c.kind === 'PREPAY') ? 'TAX_PAYMENT' : 'OTHER_TAX_PAYMENT';
    }
    var hay = tx.summary + ' ' + tx.memo;
    for (var i = 0; i < keywords.length; i++) if (hay.indexOf(keywords[i]) >= 0) return 'NON_CUSTOMER';
    return 'CUSTOMER_PAYMENT';
  }

  /** 初始建立用（M2 6.3）：客戶收款中帶「未歸類 標註」者，標註、帳號、戶名的不重複組合與次數；不含金額與日期 */
  function customerCombos(txns, opts) {
    var map = {}, list = [];
    txns.forEach(function (tx) {
      if (classify(tx, opts) !== 'CUSTOMER_PAYMENT') return;
      var p = parseMemo(tx.summary, tx.memo);
      if (!p.payerTag) return;
      var k = p.payerTag + '\u0001' + p.payerAccount + '\u0001' + p.payerName;
      if (!map[k]) { map[k] = { tag: p.payerTag, account: p.payerAccount, name: p.payerName, count: 0 }; list.push(map[k]); }
      map[k].count++;
    });
    return list;
  }

  /** 重複檢查碼的原文（M2 3.4）：交易日時|摘要|金額，不含備註；實際雜湊（SHA-256）在呼叫端做 */
  function txnKeyText(tx) { return tx.dt + '|' + tx.summary + '|' + tx.amount; }

  return { readStatement: readStatement, parseMemo: parseMemo, classify: classify, customerCombos: customerCombos, txnKeyText: txnKeyText, BAD_FORMAT: BAD_FORMAT };
});
