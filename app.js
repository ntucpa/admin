/* 永承事務所管理系統｜管理後台（GitHub Pages）
 * 規格 V4.0.3 3.1：以 fetch POST（text/plain JSON）呼叫 Apps Script AdminApi；所有授權檢查在後端。
 * 所有畫面文字以 textContent 輸出，不使用 innerHTML 插入資料。 */
(function () {
  'use strict';

  var API_URL = window.YC_CONFIG.API_URL;
  var TOKEN_KEY = 'yc_admin_token';
  var token = '';
  var me = null;
  var params = new URLSearchParams(location.search);

  /* ---------- 快速通道（Cloudflare 閘道） ----------
   * GATEWAY_ACTIONS 內的查詢改送閘道：閘道驗證登入憑證後直接讀 Cloudflare 的資料副本回答（約 0.5 秒）；
   * 憑證缺少、過期，或副本不可靠時，閘道會自動改問 Apps Script，所以不會比以前更不穩。
   * 要整個關閉：把 config.js 的 GATEWAY_ACTIONS 改成 {}（或刪掉 GATEWAY_URL）。 */
  var GATEWAY_URL = window.YC_CONFIG.GATEWAY_URL || '';
  var GATEWAY_ACTIONS = window.YC_CONFIG.GATEWAY_ACTIONS || {};
  var JWT_KEY = 'yc_admin_jwt';
  var jwt = '', jwtExp = 0, jwtPending = null, jwtTimer = null;

  /* ---------- 共用 ---------- */
  /** 登入保存於本機（V4.0.4 第七章：個人電腦登入保持數天，由後端控制到期與停用） */
  function store(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function badge(text, cls) { return el('span', { class: 'badge ' + (cls || '') }, text); }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return String(iso);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function folderLink(id) {
    if (!id) return el('span', { class: 'muted' }, '未設定');
    return el('a', { href: 'https://drive.google.com/drive/folders/' + encodeURIComponent(id), target: '_blank', rel: 'noopener' }, '開啟資料夾');
  }
  function cleanUrl() { history.replaceState({}, '', location.pathname); }

  /** 全畫面等待提示；超過 8 秒補充說明，避免誤以為當機 */
  var busyTimer = null;
  function showBusy(text) {
    $('busyText').textContent = text || '處理中…';
    $('busySub').textContent = '';
    $('busy').classList.remove('hidden');
    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () {
      $('busySub').textContent = '系統回應較慢，請稍候，不要關閉或重新整理頁面。（系統更新後的第一次操作可能需要 20～30 秒）';
    }, 8000);
  }
  function hideBusy() { clearTimeout(busyTimer); $('busy').classList.add('hidden'); }

  /** 登入憑證（約 15 分鐘）：只放記憶體與本分頁的 sessionStorage；由 Apps Script 以長效登入換發 */
  function jwtFresh() { return !!jwt && jwtExp - Date.now() > 90000; }
  function startJwtTimer() {
    if (jwtTimer) return;
    jwtTimer = setInterval(function () { if (token && !jwtFresh()) ensureJwt(); }, 2 * 60000);
  }
  function setJwt(a) {
    if (!a || !a.jwt) return;
    jwt = a.jwt; jwtExp = a.exp * 1000;
    try { sessionStorage.setItem(JWT_KEY, JSON.stringify({ jwt: jwt, exp: a.exp })); } catch (e) {}
    startJwtTimer();
  }
  function clearJwt() {
    jwt = ''; jwtExp = 0; jwtPending = null;
    if (jwtTimer) { clearInterval(jwtTimer); jwtTimer = null; }
    try { sessionStorage.removeItem(JWT_KEY); } catch (e) {}
  }
  function restoreJwt() {
    try {
      var o = JSON.parse(sessionStorage.getItem(JWT_KEY) || 'null');
      if (o && o.jwt && o.exp * 1000 > Date.now()) { jwt = o.jwt; jwtExp = o.exp * 1000; startJwtTimer(); }
    } catch (e) { /* 沒有可用的就重新換發 */ }
  }
  /** 回傳可用的憑證；換發失敗回傳空字串（請求仍會送出，由閘道改問 Apps Script） */
  function ensureJwt() {
    if (jwtFresh()) return Promise.resolve(jwt);
    if (!token) return Promise.resolve('');
    if (jwtPending) return jwtPending;
    jwtPending = fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'auth.issue', typ: 'admin', token: token }) })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (r && r.ok) setJwt(r.data); return jwtFresh() ? jwt : ''; }, function () { return ''; })
      .then(function (j) { jwtPending = null; return j; });
    return jwtPending;
  }

  /** 暖機：預先喚醒後端，縮短接下來真正操作的等待時間 */
  function warmUp() {
    fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'admin.ping' }) }).then(null, function () {});
  }

  /** 只讀取、不寫入的動作：遇到 Google 連線錯誤時可安全地自動重試 */
  var READ_ONLY = { ping: 1, loginUrl: 1, getHome: 1, getSettings: 1, listCompanies: 1, getUnclassifiedFolder: 1, listAdmins: 1, checkEmail: 1, listBindings: 1, listCustomers: 1, customerHistory: 1, listInvites: 1, listUnclassified: 1, listExceptions: 1, takeoverReport: 1, listAudit: 1, driveAudit: 1, previewCompanyImport: 1, listIntake: 1, listBackups: 1, 'tax.getBoard': 1, 'tax.getHome': 1, 'bank.listAliases': 1, 'bank.bootstrapPreview': 1, 'bank.getContext': 1, 'bank.listRecent': 1, 'bank.suggestAliases': 1, 'bank.getLedger': 1, 'tax.getNoticeList': 1, 'tax.getRecipients': 1, 'tax.getNoticeSettings': 1, 'tax.getDocSettings': 1, 'ai.getSettings': 1, 'tax.memoSummary': 1, 'tax.listProfiles': 1, 'tax.checkBills': 1, 'tax.getSettings': 1, 'tax.testClassify': 1, 'tax.billsStatus': 1 };
  var NET_ERR = 'Google 連線暫時不穩，請稍後再試一次。若是儲存或新增，請先重新整理頁面確認是否已完成，避免重複操作。';

  /** timeoutMs>0：等太久就放棄（讀取類動作由 api() 馬上重試）。Apps Script 窗口實測約每 4 次有 1 次要等 10～30 秒才失敗，與其乾等不如快速放棄重來 */
  function post(url, body, timeoutMs) {
    var opts = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) };
    if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs);
    return fetch(url, opts)
      .then(function (r) {
        if (!r.ok) throw { code: 'NETWORK', message: NET_ERR };
        var route = r.headers.get('x-yc-route') || '';
        return r.json().then(function (j) { j._route = route; return j; }, function () { throw { code: 'NETWORK', message: NET_ERR }; });
      }, function () { throw { code: 'NETWORK', message: NET_ERR }; });
  }

  function once(name, args, t0, tmo) {
    var action = 'admin.' + name;
    var direct = function () { return post(API_URL, { action: action, token: token, args: args || {} }, tmo); };
    var p;
    if (GATEWAY_URL && GATEWAY_ACTIONS[name]) {
      p = ensureJwt().then(function (j) { return post(GATEWAY_URL, { action: action, token: token, jwt: j, args: args || {} }); })
        .then(null, function (e) { if (e && e.code === 'NETWORK' && name.indexOf('tax.') !== 0) return direct(); throw e; }); // 閘道連不上時直接問 Apps Script（稅務動作沒有 Apps Script 版本，不備援）
    } else {
      p = direct();
    }
    return p.then(function (r) {
      var via = r._route === 'cloudflare' ? '｜快速通道（Cloudflare）' : (r._route && r._route.indexOf('fallback') === 0 ? '｜快速通道暫時無法使用，已改由 Apps Script 回答' : '');
      $('perf').textContent = '最近一次操作：伺服器處理 ' + ((r.ms || 0) / 1000).toFixed(1) + ' 秒｜總耗時 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒' + via;
      if (r.ok) return r.data;
      throw r.error || { code: 'INTERNAL', message: '系統發生錯誤' };
    });
  }

  /** 呼叫後端 AdminApi；回傳 Promise<data>，失敗時 reject {code, message}。讀取類動作遇連線錯誤自動重試 2 次 */
  function api(name, args) {
    var t0 = Date.now();
    var tries = READ_ONLY[name] ? 4 : 1;
    var LIMITS = [9000, 12000, 15000, 20000]; // 讀取類每次嘗試的最長等待（毫秒）；寫入類不設限（避免重複寫入）
    function attempt(n) {
      return once(name, args, t0, READ_ONLY[name] ? LIMITS[n - 1] : 0).then(null, function (err) {
        if (err.code === 'NETWORK' && n < tries) return attempt(n + 1);
        throw err;
      });
    }
    return attempt(1);
  }

  /** api 的簡便版：失敗時自動處理登入逾時，其他錯誤交給 onErr 或跳出提示 */
  function call(name, args, onOk, onErr) {
    return api(name, args).then(onOk, function (err) {
      if (err.code === 'SESSION_EXPIRED') { closeModal(); return showLogin(err.message); }
      if (onErr) onErr(err); else alert(err.message);
    });
  }

  /* ---------- 對話框 ---------- */
  function openModal(title) {
    var m = $('modal'); m.innerHTML = '';
    m.appendChild(el('h2', {}, title));
    $('overlay').classList.remove('hidden');
    return m;
  }
  function closeModal() { $('overlay').classList.add('hidden'); $('modal').innerHTML = ''; $('modal').style.width = ''; }
  /**
   * 檔案選擇的共用元件（開發原則：所有「選擇檔案」的地方都要同時支援拖拉與點選）。
   * 把 dz（拖放區）接上：拖進來或點 pick 按鈕選擇的檔案，副檔名符合 extRe 才交給 onFiles(FileList 轉成陣列)；
   * 不符合時提示。multi=false 時只收第一個檔案。
   */
  function wireDropZone(dz, input, pick, extRe, multi, onFiles) {
    function take(list) {
      var files = Array.prototype.slice.call(list || []);
      if (!files.length) return;
      var okFiles = files.filter(function (f) { return extRe.test(f.name); });
      if (!okFiles.length) { alert('這裡只接受這些格式的檔案：' + (input.getAttribute('accept') || '指定格式') + '。'); return; }
      onFiles(multi ? okFiles : okFiles.slice(0, 1));
    }
    if (pick) pick.onclick = function (e) { e.preventDefault(); input.click(); };
    dz.addEventListener('click', function (e) { if (e.target === dz && !pick) input.click(); });
    input.onchange = function () { take(input.files); input.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.style.background = '#e8eef5'; }); });
    dz.addEventListener('dragleave', function (e) { e.preventDefault(); dz.style.background = ''; });
    dz.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); dz.style.background = ''; take(e.dataTransfer && e.dataTransfer.files); });
  }
  /** 沒拖進拖放區就放開時，不讓瀏覽器把檔案「打開」而離開後台頁面 */
  ['dragover', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) e.preventDefault(); }); });

  function field(parent, label, input, hint) {
    var f = el('div', { class: 'field' });
    f.appendChild(el('label', {}, label));
    f.appendChild(input);
    if (hint) f.appendChild(el('div', { class: 'muted' }, hint));
    parent.appendChild(f);
    return input;
  }
  function modalActions(parent, okText, onOk) {
    var msg = el('div', { class: 'msg' });
    var bar = el('div', { class: 'actions' });
    var cancel = el('button', { class: 'btn secondary' }, '取消');
    var ok = el('button', { class: 'btn' }, okText);
    cancel.onclick = closeModal;
    ok.onclick = function () {
      ok.disabled = true; msg.className = 'msg'; msg.textContent = '處理中…';
      onOk(function (text) { ok.disabled = false; msg.className = 'msg err'; msg.textContent = text; });
    };
    bar.appendChild(cancel); bar.appendChild(ok);
    parent.appendChild(msg); parent.appendChild(bar);
  }

  /* ---------- 登入 ---------- */
  var loginPurpose = {};

  function showLogin(message, notice) {
    token = ''; store(TOKEN_KEY, ''); clearJwt();
    $('appView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    $('loginError').classList.toggle('hidden', !message);
    $('loginError').textContent = message || '';
    $('loginNotice').classList.toggle('hidden', !notice);
    $('loginNotice').textContent = notice || '';
    warmUp();
  }

  $('loginBtn').onclick = function () {
    var btn = $('loginBtn'); btn.disabled = true;
    showBusy('正在前往 LINE 登入…');
    api('loginUrl', loginPurpose).then(function (url) { location.href = url; }, function (err) {
      hideBusy(); btn.disabled = false; showLogin(err.message);
    });
  };

  function showPurposePrompt(kind) {
    showLogin('', '');
    if (kind === 'invite') {
      $('loginSub').textContent = '管理員邀請';
      $('loginHint').textContent = '請使用您本人的 LINE 帳號登入，完成後即成為管理員。';
      $('loginBtn').textContent = '接受邀請並以 LINE 登入';
    } else {
      $('loginSub').textContent = '確認管理員 Google 帳號';
      $('loginHint').textContent = '請使用管理員本人的 LINE 帳號登入，完成確認。';
      $('loginBtn').textContent = '以 LINE 登入並確認';
    }
  }

  function showApp(home) {
    me = home.admin;
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('who').textContent = me.name + '（' + (me.role === 'SUPER_ADMIN' ? '超級管理員' : '管理員') + '）';
    document.querySelectorAll('.super-only').forEach(function (n) { n.classList.toggle('hidden', me.role !== 'SUPER_ADMIN'); });
    document.querySelectorAll('nav a[data-feature]').forEach(function (n) { n.classList.toggle('hidden', !n.getAttribute('data-feature').split('|').some(function (f) { return (me.features || []).indexOf(f) >= 0; })); });
    navGroupsRefresh();
    renderHome(home);
    refreshMemoBadge();
  }

  /** 頂列備忘圖示（所有頁面可見）：灰＝沒有未完成；黃底加數字＝有未完成；紅底「今天到期 N」＝有到期或過期。沒有稅務權限者不顯示 */
  var scrollToMemo = false;
  function refreshMemoBadge() {
    var b = $('memoBtn');
    call('tax.memoSummary', {}, function (r) {
      b.classList.remove('hidden');
      var style = 'border:1px solid #cfd6df;background:#f2f4f7;color:#667085;font-weight:400;', text = '📝 備忘';
      if (r.due > 0) { style = 'border:1px solid #c0392b;background:#c0392b;color:#fff;font-weight:700;'; text = '📝 今天到期 ' + r.due; }
      else if (r.open > 0) { style = 'border:1px solid #ecd987;background:#fff2b8;color:#6b5400;font-weight:700;'; text = '📝 備忘 ' + r.open; }
      b.style.cssText = 'margin-right:8px;border-radius:14px;padding:2px 10px;font-size:13px;' + style;
      b.textContent = text;
      b.title = r.open ? ('未完成 ' + r.open + ' 則' + (r.due ? '，其中 ' + r.due + ' 則已到期' : '')) : '沒有未完成的備忘';
    }, function () { b.classList.add('hidden'); });
  }
  $('memoBtn').onclick = function () { scrollToMemo = true; go('tax'); if (taxHomeData) { renderTaxHome(); } };

  /* ---------- 首頁 ---------- */
  function renderHome(home) {
    var pend = home.pendingBindings;
    $('statPending').classList.toggle('hidden', pend === null || pend === undefined);
    $('statPendingValue').textContent = pend || 0;
    $('statPendingValue').className = 'value' + (pend ? ' warn' : '');
    setNavPending(pend);
    var lu = home.lineUsage;
    $('statLine').classList.toggle('hidden', !lu);
    if (lu) {
      if (!lu.ok) { $('statLineValue').textContent = '—'; $('statLineValue').className = 'value'; $('statLineNote').textContent = lu.message; }
      else {
        var lp = lu.limit ? Math.round(lu.used / lu.limit * 100) : 0;
        $('statLineValue').textContent = lu.used + (lu.limit ? ' ／ ' + lu.limit + ' 則' : ' 則（無上限）');
        $('statLineValue').className = 'value' + (lu.limit && lp >= 100 ? ' err' : lu.limit && lp >= 80 ? ' warn' : '');
        $('statLineNote').textContent = (lu.limit && lp >= 80 ? '已達上限的 ' + lp + '%｜' : '') + '只計系統主動推送（失敗與重新綁定通知）；回覆客戶不計入';
      }
    }
    var ik = home.intake;
    $('statIntake').classList.toggle('hidden', !ik);
    if (ik) {
      $('statIntakeValue').textContent = ik.enabled ? ik.files + ' 份' : '尚未啟用';
      $('statIntakeValue').className = 'value' + (ik.files ? ' warn' : '');
      $('statIntakeNote').textContent = ik.enabled ? (ik.months ? ik.months + ' 家公司月份待處理' + (ik.reopened ? '｜' + ik.reopened + ' 家已處理後又有新檔案' : '') + (ik.review ? '｜' + ik.review + ' 份需人工確認' : '') : '目前沒有待處理的客戶上傳文件') + (ik.ghPercent >= 70 ? '｜⚠ GitHub 用量約 ' + ik.ghPercent + '%' : '') : '點此啟用';
      setNavCount('navIntake', ik.months);
    }
    var bk = home.backup;
    $('statBackup').classList.toggle('hidden', !bk);
    if (bk) {
      $('statBackupValue').textContent = !bk.enabled ? '尚未啟用' : (bk.lastFailed ? '備份失敗' : (bk.lastOkAt ? '正常' : '尚無備份'));
      $('statBackupValue').className = 'value' + (!bk.enabled || bk.lastFailed ? ' err' : (bk.ackOverdue ? ' warn' : ''));
      $('statBackupNote').textContent = !bk.enabled ? '點此啟用' :
        ('最近成功：' + (bk.lastOkAt ? fmtTime(bk.lastOkAt) : '—') + (bk.ackOverdue ? '｜⚠ 已 ' + bk.daysSinceAck + ' 天沒下載到地端' : (bk.ackAt ? '｜上次下載到地端：' + fmtTime(bk.ackAt) : '')));
      setNavCount('navBackup', bk.enabled && (bk.lastFailed || bk.ackOverdue) ? '!' : 0);
      backupReminder(bk);
    }
    var cn = home.counts;
    if (cn) {
      $('statUncValue').textContent = cn.unclassified.files + ' 份';
      $('statUncValue').className = 'value' + (cn.unclassified.files ? ' warn' : '');
      $('statUncNote').textContent = cn.unclassified.files ? cn.unclassified.customers + ' 位客戶｜最久已等待 ' + cn.unclassified.oldestDays + ' 天' : '目前沒有未分類的文件';
      setNavCount('navUnc', cn.unclassified.customers);
      $('statExc').classList.toggle('hidden', cn.exceptions === null);
      $('statExcValue').textContent = (cn.exceptions || 0) + ' 件';
      $('statExcValue').className = 'value' + (cn.exceptions ? ' err' : '');
      setNavCount('navExc', cn.exceptions);
    }
    var rn = home.runner;
    if (rn) {
      var pct = rn.budgetMinutes ? Math.round(rn.minutesToday / rn.budgetMinutes * 100) : 0;
      $('statUsage').textContent = '約 ' + rn.minutesToday + ' ／ ' + rn.budgetMinutes + ' 分鐘';
      $('statUsage').className = 'value' + (rn.stopped ? ' err' : pct >= rn.warnPercent ? ' warn' : '');
      // 滑過數字可看「今天額度花在哪」（毫秒累計換算成分鐘）：副本同步、LINE 發送佇列、歸檔等主要工作、文件目錄索引、申報書讀取
      if (rn.parts) {
        var PN = { sync: '副本同步', notice: 'LINE 發送佇列', round: '歸檔等主要工作', dix: '文件目錄索引', docs: '申報書讀取', flush: '資料推送' };
        var tip = Object.keys(PN).filter(function (k) { return rn.parts[k]; }).map(function (k) { return PN[k] + ' ' + (Math.round(rn.parts[k] / 6000) / 10) + ' 分'; });
        $('statUsage').title = tip.length ? '今日各部分耗時：' + tip.join('、') : '';
      }
      $('statUsageNote').textContent = rn.stopped
        ? (rn.lastHeartbeatAt ? '背景處理已停止，可能是今日額度已用完，請稍後查看或聯絡系統維護人員' : '背景處理尚未啟動')
        : '最後運作：' + fmtTime(rn.lastHeartbeatAt) + (rn.hasPendingWork ? '｜有工作處理中' : '');
    }
    renderHomeTodo(home);
    var box = $('sysCard'); box.innerHTML = '';
    box.appendChild(el('div', { class: 'muted' }, home.firmName + '｜系統版本 ' + home.version + '｜伺服器時間 ' + home.serverTime));
    if (home.system) {
      var s = home.system;
      box.appendChild(el('div', { style: 'margin-top:10px;font-weight:600' }, '系統資訊（僅超級管理員可見）'));
      var ul = el('ul');
      [['主資料庫', s.mainSpreadsheetUrl], ['日誌', s.logSpreadsheetUrl]].forEach(function (x) {
        var li = el('li'); li.appendChild(el('a', { href: x[1], target: '_blank', rel: 'noopener' }, x[0])); ul.appendChild(li);
      });
      ul.appendChild(el('li', {}, '管理員人數：' + s.adminCount + '｜公司數：' + s.companyCount));
      box.appendChild(ul);
      box.appendChild(el('div', { class: 'muted' }, '提醒：資料表請勿直接編輯，系統參數請使用左側「系統設定」。'));
    }
  }

  function go(page) {
    // 發票辨識：開公司電腦上的入口頁（另開分頁）；還沒設定網址時顯示說明
    if (page === 'invoiceai') {
      var url = (window.YC_CONFIG || {}).INVOICE_AI_URL;
      if (url) { window.open(url, '_blank', 'noopener'); return; }
      showDevPage('發票辨識', '發票辨識的入口頁將放在公司電腦（進項、銷項等多支辨識程式從這裡進入），只有在公司網路或遠端連線時打得開。入口頁設定好後，點這裡會直接開啟。');
    }
    if (DEV_PAGES[page]) showDevPage(DEV_PAGES[page].title, DEV_PAGES[page].text);
    var section = (page === 'invoiceai' || DEV_PAGES[page]) ? 'dev' : page;
    var navPage = (page === 'taxup' || page === 'taxsettings') ? 'tax' : page;
    navExpandFor(navPage);
    document.querySelectorAll('nav a[data-page]').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-page') === navPage); });
    document.querySelectorAll('main section').forEach(function (s) { s.classList.toggle('hidden', s.id !== 'page-' + section); });
    document.querySelector('main').style.maxWidth = (page === 'tax' || page === 'taxup' || page === 'taxsettings' || page === 'bank') ? 'none' : '';
    if (page === 'taxup') loadUploadPage();
    if (page === 'taxsettings') loadTaxSettings();
    if (page === 'tax') loadTax();
    if (page === 'bank') showBankPage();
    if (page === 'home') call('getHome', {}, renderHome);
    if (page === 'overview') loadOverview();
    if (page === 'companies') loadCompanies();
    if (page === 'bindings') loadBindings();
    if (page === 'customers') loadCustomers();
    if (page === 'invites') loadInvites();
    if (page === 'unclassified') loadUncReminder();
    if (page === 'intake') loadIntake();
    if (page === 'backup') loadBackup();
    if (page === 'exceptions') loadExceptions();
    if (page === 'takeover') loadTakeover();
    if (page === 'audit') loadAudit(false);
    if (page === 'admins') loadAdmins();
    if (page === 'settings') { renderAiSettings(); loadUnclassified(); loadSettings(); }
  }

  /* ---------- 公司管理 ---------- */
  function loadCompanies() {
    $('companyBox').textContent = '載入中…';
    call('listCompanies', {}, function (d) {
      $('addCompanyBtn').classList.toggle('hidden', !d.canCreate);
      var box = $('companyBox'); box.innerHTML = '';
      if (!d.companies.length) { box.appendChild(el('div', { class: 'muted' }, d.canCreate ? '尚未建立任何公司，請按「新增公司」。' : '您目前沒有負責的公司。')); return; }
      var t = el('table');
      var cg = el('colgroup'); ['110px', '', '90px', '110px', d.canManage ? '230px' : '0'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
      var h = el('tr'); ['統一編號', '公司名稱', '狀態', '公司資料夾', d.canManage ? '操作' : ''].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      d.companies.forEach(function (c) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, c.companyId));
        var nmTd = el('td'), nmBtn = el('button', { class: 'linkbtn', style: 'text-decoration:none;color:inherit;text-align:left', title: '點一下看這家的客戶總覽' }, c.name + (c.fullName ? '（' + c.fullName + '）' : ''));
        nmBtn.onclick = function () { openOverview(c.companyId); }; nmTd.appendChild(nmBtn); tr.appendChild(nmTd);
        var st = el('td'); st.appendChild(c.status === 'ACTIVE' ? badge('啟用', 'ok') : badge('停用', 'off')); tr.appendChild(st);
        var fd = el('td'); fd.appendChild(folderLink(c.folderId)); tr.appendChild(fd);
        var op = el('td');
        if (d.canManage) {
          var b1 = el('button', { class: 'btn small secondary' }, '改名'); b1.onclick = function () { renameCompanyDialog(c); };
          var b2 = el('button', { class: 'btn small secondary' }, c.folderId ? '更換資料夾' : '設定資料夾'); b2.onclick = function () { folderDialog(c); };
          var b3 = el('button', { class: 'btn small ' + (c.status === 'ACTIVE' ? 'danger' : 'secondary') }, c.status === 'ACTIVE' ? '停用' : '啟用');
          b3.onclick = function () { toggleCompany(c); };
          op.appendChild(b1); op.appendChild(b2); op.appendChild(b3);
        }
        tr.appendChild(op);
        t.appendChild(tr);
      });
      box.appendChild(t);
    }, function (err) { $('companyBox').textContent = err.message; });
  }

  $('addCompanyBtn').onclick = function () {
    var m = openModal('新增公司');
    var id = field(m, '統一編號（8 碼）', el('input', { type: 'text', maxlength: '8', inputmode: 'numeric' }), '建立後不可修改，請仔細核對。');
    var name = field(m, '公司簡稱（用於檔名）', el('input', { type: 'text' }), '會用在檔名，建議簡短，例如：佳軒。');
    var fullName = field(m, '公司全名（客戶綁定時顯示，可不填）', el('input', { type: 'text' }), '例如：佳軒管理顧問有限公司。不填時客戶會看到簡稱。');
    var folder = field(m, '公司資料夾網址（可稍後設定）', el('input', { type: 'text', placeholder: 'https://drive.google.com/drive/folders/…' }));
    modalActions(m, '建立', function (fail) {
      call('createCompany', { companyId: id.value.trim(), name: name.value, fullName: fullName.value, folder: folder.value.trim() },
        function () { closeModal(); loadCompanies(); }, function (e) { fail(e.message); });
    });
  };

  function renameCompanyDialog(c) {
    var m = openModal('修改公司名稱');
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '統一編號 ' + c.companyId + '。簡稱用於檔名，改名不會回溯修改已歸檔的檔名；全名只顯示給客戶看。'));
    var name = field(m, '公司簡稱（用於檔名）', el('input', { type: 'text' }));
    name.value = c.name;
    var fullName = field(m, '公司全名（客戶綁定時顯示，可不填）', el('input', { type: 'text' }));
    fullName.value = c.fullName || '';
    modalActions(m, '儲存', function (fail) {
      call('renameCompany', { companyId: c.companyId, name: name.value }, function () {
        call('setCompanyFullName', { companyId: c.companyId, fullName: fullName.value }, function () { closeModal(); loadCompanies(); }, function (e) { fail(e.message); });
      }, function (e) { fail(e.message); });
    });
  }

  function folderDialog(c) {
    var m = openModal((c.folderId ? '更換' : '設定') + '公司資料夾：' + c.name);
    if (c.folderId) m.appendChild(el('div', { class: 'alert' }, '更換後，客戶與管理員的權限會從舊資料夾移到新資料夾；舊資料夾內的文件不會自動搬移。'));
    var folder = field(m, '公司資料夾網址', el('input', { type: 'text', placeholder: 'https://drive.google.com/drive/folders/…' }),
      '系統會檢查：資料夾存在、擁有者為系統帳號、不與其他公司或待分類資料夾重疊。');
    modalActions(m, '驗證並設定', function (fail) {
      call('setCompanyFolder', { companyId: c.companyId, folder: folder.value.trim() }, function () { closeModal(); loadCompanies(); }, function (e) { fail(e.message); });
    });
  }

  function toggleCompany(c) {
    var to = c.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    var text = to === 'SUSPENDED' ? '停用後此公司不再收新文件，但客戶仍可瀏覽歷史文件、檔案不會刪除。確定停用「' + c.name + '」？' : '確定重新啟用「' + c.name + '」？';
    if (!confirm(text)) return;
    call('setCompanyStatus', { companyId: c.companyId, status: to }, loadCompanies);
  }

  /* ---------- 客戶綁定審核（5.1、AC-47） ---------- */
  var SOURCE_LABEL = { TAX_ID: '統編申請', INVITE: '邀請連結' };

  function setNavPending(n) { $('navPending').textContent = n ? String(n) : ''; }

  function loadBindings() {
    $('bindingBox').textContent = '載入中…';
    call('listBindings', {}, function (list) {
      setNavPending(list.length);
      var box = $('bindingBox'); box.innerHTML = '';
      if (!list.length) { box.appendChild(el('div', { class: 'muted' }, '目前沒有待審核的申請。')); return; }
      var t = el('table');
      var cg = el('colgroup'); ['120px', '', '', '', '90px', '150px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
      var h = el('tr'); ['申請時間', '客戶', '申請公司', 'Google 帳號', '來源', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      list.forEach(function (b) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, fmtTime(b.requestedAt)));
        var c1 = el('td');
        c1.appendChild(el('div', {}, 'LINE：' + (b.lineDisplayName || '（未提供）')));
        if (b.customerName) c1.appendChild(el('div', { class: 'muted' }, '稱呼：' + b.customerName));
        if (b.otherCompanies.length) c1.appendChild(el('div', { class: 'muted' }, '已綁定：' + b.otherCompanies.join('、')));
        tr.appendChild(c1);
        var c2 = el('td'); c2.appendChild(el('div', {}, b.companyName)); c2.appendChild(el('div', { class: 'muted' }, b.companyId));
        if (b.companyIssue) { c2.appendChild(badge(b.companyIssue, 'err')); c2.appendChild(el('div', { class: 'muted' }, '請先到「客戶公司」完成設定才能核准')); }
        tr.appendChild(c2);
        tr.appendChild(el('td', {}, b.googleEmail));
        var c4 = el('td'); c4.appendChild(badge(SOURCE_LABEL[b.source] || b.source)); tr.appendChild(c4);
        var op = el('td');
        var ok = el('button', { class: 'btn small' }, '審核核准'); ok.disabled = !!b.companyIssue; ok.onclick = function () { approveDialog(b); };
        var no = el('button', { class: 'btn small danger' }, '拒絕');
        no.onclick = function () {
          if (!confirm('確定拒絕「' + b.companyName + '」的綁定申請（' + b.googleEmail + '）？\n拒絕後客戶可重新申請。')) return;
          call('rejectBinding', { bindingRequestId: b.bindingRequestId }, loadBindings);
        };
        op.appendChild(ok); op.appendChild(no); tr.appendChild(op);
        t.appendChild(tr);
      });
      box.appendChild(t);
    }, function (err) { $('bindingBox').textContent = err.message; });
  }

  function approveDialog(b) {
    var m = openModal('核准綁定申請');
    m.appendChild(el('div', {}, '公司：' + b.companyName + '（' + b.companyId + '）'));
    m.appendChild(el('div', { class: 'muted' }, '來源：' + (SOURCE_LABEL[b.source] || b.source) + '｜LINE 名稱：' + (b.lineDisplayName || '（未提供）')));
    m.appendChild(el('div', { style: 'margin-top:12px;font-weight:600' }, '即將授權的 Google 帳號'));
    m.appendChild(el('div', { class: 'big' }, b.googleEmail));
    m.appendChild(el('p', { class: 'muted' }, '核准後，系統會把此公司資料夾的「檢視」權限授予上方 Google 帳號，此帳號可以看到並下載該資料夾內的全部文件。'));
    var name = null;
    if (b.needsCustomerName) {
      name = field(m, '客戶稱呼（首次核准必填）', el('input', { type: 'text', maxlength: '50' }));
      name.value = b.companyName;
      m.lastChild.appendChild(el('div', { class: 'internal' }, '僅供內部辨識，請使用正式名稱，勿使用不當稱呼'));
    } else {
      m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '客戶稱呼：' + b.customerName + '（可於客戶管理修改）'));
    }
    var lb = el('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:8px' });
    var cb = el('input', { type: 'checkbox' });
    lb.appendChild(cb); lb.appendChild(document.createTextNode('我已確認上方 Google 帳號正確，同意授權'));
    m.appendChild(lb);
    modalActions(m, '核准', function (fail) {
      if (!cb.checked) return fail('請先勾選確認 Google 帳號');
      call('approveBinding', { bindingRequestId: b.bindingRequestId, confirmEmail: b.googleEmail, customerName: name ? name.value : '' },
        function () { closeModal(); alert('已核准。系統將於 1～2 分鐘內自動完成雲端硬碟授權，完成後寄 Email 通知客戶。'); loadBindings(); },
        function (e) { fail(e.message); });
    });
  }

  /* ---------- 客戶管理（第十七章、5.4、5.6、5.7） ---------- */
  var custData = null;
  var UCP_STATUS = { PENDING_SYNC: ['設定中', 'warn'], ACTIVE: ['生效中', 'ok'], SUSPENDED: ['已暫停', 'off'], REVOKED: ['已解除', 'off'] };

  function loadCustomers() {
    $('customerBox').textContent = '載入中…';
    call('listCustomers', {}, function (d) { custData = d; renderCustomers(); }, function (err) { $('customerBox').textContent = err.message; });
  }

  $('custSearch').addEventListener('input', function () { if (custData) renderCustomers(); });

  function driveCell(b, caps) {
    var td = el('td'); var d = b.drive;
    if (!d) { td.appendChild(el('span', { class: 'muted' }, '—')); return td; }
    var map = { ACTIVE: ['已授權', 'ok'], PENDING: ['授權中', 'warn'], SYNCING: ['授權中', 'warn'], SYNC_FAILED: ['授權失敗', 'err'], REVOKING: ['撤銷中', 'warn'], REVOKED: ['已撤銷', 'off'] };
    var s = map[d.status] || [d.status, ''];
    if (d.status === 'REVOKING' && d.retryExhausted) s = ['撤銷失敗', 'err'];
    td.appendChild(badge(s[0], s[1]));
    if (d.status === 'SYNC_FAILED' || (d.status === 'REVOKING' && d.retryExhausted)) {
      if (d.lastError) td.appendChild(el('div', { class: 'muted' }, driveErrorText(d.lastError)));
      if (caps.canResync) {
        var r = el('button', { class: 'btn small secondary' }, d.status === 'SYNC_FAILED' ? '重新同步' : '重試撤銷');
        r.onclick = function () { call('retryPermission', { permissionId: d.permissionId }, function () { alert('已排入背景處理，約 1～2 分鐘後完成。'); loadCustomers(); }); };
        td.appendChild(el('div')).appendChild(r);
      }
    }
    return td;
  }

  function driveErrorText(msg) {
    if (/no Google account|Notify people/i.test(msg)) return '此 Email 不是 Google 帳號，請與客戶確認後「變更帳號」';
    return msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
  }

  function renderCustomers() {
    var d = custData, caps = d.capabilities;
    var box = $('customerBox'); box.innerHTML = '';
    var k = $('custSearch').value.trim().toLowerCase();
    var list = d.customers.filter(function (c) {
      if (!k) return true;
      var text = [c.customerName, c.lineDisplayName, c.email].concat(c.bindings.map(function (b) { return b.companyName + ' ' + b.companyId + ' ' + b.googleEmail; })).join(' ').toLowerCase();
      return text.indexOf(k) >= 0;
    });
    $('custCount').textContent = '共 ' + list.length + ' 位客戶';
    if (!d.customers.length) { box.appendChild(el('div', { class: 'card muted' }, '尚無客戶。客戶在 LINE 申請綁定並經核准後，會出現在這裡。')); return; }
    list.forEach(function (c) {
      var anon = c.status === 'ANONYMIZED';
      var card = el('div', { class: 'cust' });
      var head = el('div', { class: 'cust-head' });
      head.appendChild(el('span', { class: 'name' }, c.customerName || '（未設定稱呼）'));
      if (anon) head.appendChild(badge('已清除個人資料', 'off'));
      if (!anon && c.lineDisplayName) head.appendChild(el('span', { class: 'muted' }, 'LINE：' + c.lineDisplayName));
      if (!anon && caps.canEditCustomer && c.bindings.some(function (b) { return b.status !== 'REVOKED'; })) {
        var bn = el('button', { class: 'linkbtn' }, '修改稱呼'); bn.onclick = function () { nameDialog(c); }; head.appendChild(bn);
      }
      var bh = el('button', { class: 'linkbtn' }, '綁定歷程'); bh.onclick = function () { historyDialog(c); }; head.appendChild(bh);
      if (!anon && caps.isSuper && c.bindings.every(function (b) { return b.status === 'REVOKED'; })) {
        var ba = el('button', { class: 'linkbtn', style: 'color:#b42318' }, '清除個人資料'); ba.onclick = function () { anonymizeDialog(c); }; head.appendChild(ba);
      }
      card.appendChild(head);
      var t = el('table');
      var cg = el('colgroup'); ['', '', '80px', '150px', '170px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
      var h = el('tr'); ['公司', 'Google 帳號（下載用）', '綁定', '雲端權限', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      c.bindings.forEach(function (b) {
        var tr = el('tr', b.status === 'REVOKED' ? { class: 'dim' } : {});
        var c1 = el('td'); c1.appendChild(el('div', {}, b.companyName)); c1.appendChild(el('div', { class: 'muted' }, b.companyId)); tr.appendChild(c1);
        var c2 = el('td'); c2.appendChild(el('div', {}, b.googleEmail));
        if (!anon && caps.canEditCustomer && b.status !== 'REVOKED') {
          var be = el('button', { class: 'linkbtn' }, '變更帳號'); be.onclick = function () { customerEmailDialog(c, b); }; c2.appendChild(be);
        }
        tr.appendChild(c2);
        var st = UCP_STATUS[b.status] || [b.status, '']; var c3 = el('td'); c3.appendChild(badge(st[0], st[1])); tr.appendChild(c3);
        tr.appendChild(driveCell(b, caps));
        var op = el('td');
        if (caps.canApprove && !anon) {
          if (b.status === 'ACTIVE' || b.status === 'PENDING_SYNC') op.appendChild(opButton('暫停', 'secondary', b, 'SUSPEND'));
          if (b.status === 'SUSPENDED') op.appendChild(opButton('恢復', 'secondary', b, 'RESTORE'));
          if (b.status !== 'REVOKED') op.appendChild(opButton('解除綁定', 'danger', b, 'REVOKE'));
        }
        tr.appendChild(op);
        t.appendChild(tr);
      });
      var wrap = el('div', { style: 'overflow-x:auto' }); wrap.appendChild(t); card.appendChild(wrap);
      box.appendChild(card);
    });
  }

  var OP_TEXT = {
    SUSPEND: '暫停後，系統會撤銷此 Google 帳號對「{c}」資料夾的檢視權限，客戶也無法再傳文件到這家公司。之後可以按「恢復」。確定暫停？',
    RESTORE: '恢復後，系統會重新授予「{c}」資料夾的檢視權限。確定恢復？',
    REVOKE: '解除綁定後，系統會撤銷「{c}」資料夾的檢視權限，而且無法直接恢復（客戶需重新申請或使用邀請連結）。確定解除綁定？'
  };
  function opButton(text, cls, b, op) {
    var btn = el('button', { class: 'btn small ' + cls }, text);
    btn.onclick = function () {
      if (!confirm(OP_TEXT[op].replace('{c}', b.companyName))) return;
      call('setBindingStatus', { ucpId: b.ucpId, op: op }, loadCustomers);
    };
    return btn;
  }

  function nameDialog(c) {
    var m = openModal('修改客戶稱呼');
    var input = field(m, '客戶稱呼', el('input', { type: 'text', maxlength: '50' }));
    input.value = c.customerName;
    m.lastChild.appendChild(el('div', { class: 'internal' }, '僅供內部辨識，請使用正式名稱，勿使用不當稱呼'));
    modalActions(m, '儲存', function (fail) {
      call('setCustomerName', { userId: c.userId, name: input.value }, function () { closeModal(); loadCustomers(); }, function (e) { fail(e.message); });
    });
  }

  function customerEmailDialog(c, b) {
    var m = openModal('變更 Google 帳號：' + b.companyName);
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '目前：' + b.googleEmail + '。變更後系統會撤銷舊帳號的檢視權限、授權新帳號，完成後寄 Email 通知客戶。'));
    var input = field(m, '新的 Google 帳號（Email）', el('input', { type: 'text', placeholder: 'name@gmail.com' }));
    modalActions(m, '下一步', function (fail) {
      call('checkEmail', { email: input.value }, function (r) {
        var addr = r.email;
        if (r.suggestion && confirm('您是不是要輸入「' + r.suggestion + '」？\n按「確定」採用建議，按「取消」維持原輸入。')) addr = r.suggestion;
        confirmBig('請確認新的 Google 帳號', addr, '此帳號將取得「' + b.companyName + '」資料夾的檢視權限，請確認無誤。', '確認變更', function (fail2) {
          call('setCustomerEmail', { ucpId: b.ucpId, email: addr }, function () { closeModal(); loadCustomers(); }, function (e) { fail2(e.message); });
        });
      }, function (e) { fail(e.message); });
    });
  }

  function historyDialog(c) {
    var m = openModal('綁定歷程：' + (c.customerName || c.lineDisplayName));
    var box = el('div', {}, '載入中…'); m.appendChild(box);
    var bar = el('div', { class: 'actions' }); var close = el('button', { class: 'btn secondary' }, '關閉'); close.onclick = closeModal; bar.appendChild(close); m.appendChild(bar);
    call('customerHistory', { userId: c.userId }, function (list) {
      box.innerHTML = '';
      if (!list.length) { box.textContent = '沒有紀錄'; return; }
      var t = el('table');
      var h = el('tr'); ['時間', '動作', '公司', '操作者', 'Google 帳號'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      list.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, fmtTime(x.time)));
        tr.appendChild(el('td', {}, x.label + (x.source ? '（' + (SOURCE_LABEL[x.source] || x.source) + '）' : '')));
        tr.appendChild(el('td', {}, x.companyName));
        tr.appendChild(el('td', {}, x.actor));
        tr.appendChild(el('td', {}, x.previousEmail ? x.previousEmail + ' → ' + x.email : x.email));
        t.appendChild(tr);
      });
      var wrap = el('div', { style: 'overflow-x:auto' }); wrap.appendChild(t); box.appendChild(wrap);
    }, function (e) { box.textContent = e.message; });
  }

  function anonymizeDialog(c) {
    if (!confirm('清除「' + (c.customerName || c.lineDisplayName) + '」的個人資料？\n\n會清除：LINE 識別、客戶稱呼、LINE 名稱、所有 Google 帳號紀錄。\n會保留：雲端硬碟文件與處理紀錄。\n\n此操作無法復原。')) return;
    if (!confirm('再次確認：清除後無法復原，確定執行？')) return;
    call('anonymizeCustomer', { userId: c.userId }, function () { alert('已清除個人資料。'); loadCustomers(); });
  }

  /* ---------- 未分類提醒、代客分類（9.7） ---------- */
  function daysBadge(c) { return badge(c.waitingDays + ' 天', c.warn ? 'warn' : ''); }

  function loadUncReminder() {
    $('uncBox').textContent = '載入中…';
    call('listUnclassified', {}, function (d) {
      var box = $('uncBox'); box.innerHTML = '';
      setNavCount('navUnc', d.customers.length);
      if (!d.customers.length) { box.appendChild(el('div', { class: 'muted' }, '目前沒有未分類的文件。')); return; }
      var t = el('table');
      var cg = el('colgroup'); ['', '', '70px', '120px', '80px', '150px', '170px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
      var h = el('tr'); ['客戶', '可收件公司', '份數', '最早收到', '已等待', '最近聯絡', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      d.customers.forEach(function (c) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, c.customer));
        tr.appendChild(el('td', {}, c.companies.length ? c.companies.map(function (x) { return x.name; }).join('、') : '（沒有可收件公司）'));
        tr.appendChild(el('td', {}, String(c.fileCount)));
        tr.appendChild(el('td', {}, fmtTime(c.oldestAt)));
        var w = el('td'); w.appendChild(daysBadge(c)); tr.appendChild(w);
        tr.appendChild(el('td', {}, c.lastContactAt ? fmtTime(c.lastContactAt) + '　' + c.lastContactBy : '—'));
        var op = el('td');
        var b1 = el('button', { class: 'btn small' }, '查看文件'); b1.onclick = function () { uncDialog(c, d); };
        var b2 = el('button', { class: 'btn small secondary' }, '已聯絡');
        b2.onclick = function () { if (confirm('確定已聯絡「' + c.customer + '」提醒他分類文件？')) call('markContacted', { userId: c.userId }, loadUncReminder); };
        op.appendChild(b1); op.appendChild(b2); tr.appendChild(op);
        t.appendChild(tr);
      });
      box.appendChild(t);
    }, function (err) { $('uncBox').textContent = err.message; });
  }

  function uncDialog(c, d) {
    var m = openModal('「' + c.customer + '」的未分類文件');
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '代客分類只在客戶已用電話或 LINE 明確告知文件屬於哪家公司時使用。系統不會以檔名或內容猜測公司。'));
    var checks = [];
    c.batches.forEach(function (b, bi) {
      var head = el('div', { style: 'margin-top:8px;font-weight:600' }, '第 ' + (bi + 1) + ' 批（' + b.items.length + ' 份）');
      if (d.canException) {
        var cb = el('button', { class: 'btn small danger', style: 'margin-left:8px' }, '取消整批');
        cb.onclick = function () {
          if (confirm('確定取消這整批文件？暫存檔會移入 Google 雲端硬碟垃圾桶（30 天後自動永久刪除），客戶需要重新傳送。')) {
            call('adminCancelBatch', { batchId: b.batchId }, function () { closeModal(); loadUncReminder(); });
          }
        };
        head.appendChild(cb);
      }
      m.appendChild(head);
      b.items.forEach(function (i) {
        var row = el('div', { style: 'display:flex;gap:8px;align-items:center;padding:4px 0' });
        var ck = el('input', { type: 'checkbox' }); ck.value = i.itemId; checks.push(ck);
        row.appendChild(ck);
        row.appendChild(el('span', { style: 'flex:1' }, i.fileName + '　' + fmtTime(i.receivedAt) + (i.anomaly ? '　⚠ 檔案位置異常' : '')));
        if (d.canException) {
          var done = el('button', { class: 'btn small secondary' }, '人工完成');
          done.onclick = function () {
            if (confirm('確認這份文件已在系統外處理完成？檔案位置請自行處理。')) call('exceptionAction', { itemId: i.itemId, kind: 'COMPLETE' }, function () { closeModal(); loadUncReminder(); });
          };
          var end = el('button', { class: 'btn small danger' }, '結束');
          end.onclick = function () {
            if (confirm('確定結束這份文件？暫存檔會移入垃圾桶，客戶需要重新傳送。')) call('exceptionAction', { itemId: i.itemId, kind: 'END' }, function () { closeModal(); loadUncReminder(); });
          };
          row.appendChild(done); row.appendChild(end);
        }
        m.appendChild(row);
      });
    });
    var bar = el('div', { class: 'actions', style: 'margin-top:12px;flex-wrap:wrap' });
    var msg = el('div', { class: 'msg' });
    if (d.canClassify) {
      var sel = el('select');
      c.companies.filter(function (x) { return x.inScope; }).forEach(function (x) { sel.appendChild(el('option', { value: x.companyId }, x.name)); });
      if (!sel.options.length) sel.appendChild(el('option', { value: '' }, '（沒有您負責的可收件公司）'));
      var go1 = el('button', { class: 'btn' }, '把選取的文件分類到所選公司');
      go1.onclick = function () {
        var ids = checks.filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
        if (!ids.length) { msg.className = 'msg err'; msg.textContent = '請先勾選文件'; return; }
        if (!sel.value) { msg.className = 'msg err'; msg.textContent = '沒有可選的公司'; return; }
        if (!confirm('確定把 ' + ids.length + ' 份文件分類到「' + sel.options[sel.selectedIndex].text + '」？此為客戶明確告知的公司嗎？')) return;
        call('classifyOnBehalf', { userId: c.userId, itemIds: ids, companyId: sel.value }, function () { closeModal(); loadUncReminder(); }, function (e) { msg.className = 'msg err'; msg.textContent = e.message; });
      };
      bar.appendChild(sel); bar.appendChild(go1);
    } else {
      bar.appendChild(el('span', { class: 'muted' }, '您沒有「代客分類」權限，只能查看。'));
    }
    var close = el('button', { class: 'btn secondary' }, '關閉'); close.onclick = closeModal; bar.appendChild(close);
    m.appendChild(msg); m.appendChild(bar);
  }

  /* ---------- 異常處理（12.2） ---------- */
  function loadExceptions() {
    $('excBox').textContent = '載入中…';
    call('listExceptions', {}, function (d) {
      var box = $('excBox'); box.innerHTML = '';
      var total = d.items.length + d.permissions.length + d.takeoverItems.length;
      setNavCount('navExc', total);
      if (!total) { box.appendChild(el('div', { class: 'muted' }, '目前沒有需要處理的異常。')); return; }
      if (d.items.length) {
        box.appendChild(el('div', { class: 'card-title' }, '文件異常（' + d.items.length + '）'));
        var t = el('table');
        var h = el('tr'); ['類型', '客戶', '檔名', '公司', '原因', '時間', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
        d.items.forEach(function (i) {
          var tr = el('tr');
          var k = el('td'); k.appendChild(badge(i.kind === 'FAILED' ? '處理失敗' : '位置異常', i.kind === 'FAILED' ? 'err' : 'warn')); tr.appendChild(k);
          tr.appendChild(el('td', {}, i.customer));
          tr.appendChild(el('td', {}, i.fileName));
          tr.appendChild(el('td', {}, i.company || '（未指定）'));
          tr.appendChild(el('td', {}, i.kind === 'FAILED' ? i.errorLabel + (i.errorMessage ? '：' + i.errorMessage.slice(0, 80) : '') : i.anomalyLabel));
          tr.appendChild(el('td', {}, fmtTime(i.updatedAt)));
          var op = el('td');
          var addBtn = function (text, cls, fn) { var b = el('button', { class: 'btn small ' + cls }, text); b.onclick = fn; op.appendChild(b); };
          var act = function (kind, ask) { return function () { if (confirm(ask)) call('exceptionAction', { itemId: i.itemId, kind: kind }, loadExceptions); }; };
          if (i.canRerun) addBtn('重新執行', '', act('RERUN', '重新執行這份文件的處理？'));
          if (i.canReturn) addBtn('退回待分類', 'secondary', act('RETURN', '把這份文件退回待分類？客戶或管理員可以重新選擇公司。'));
          if (i.canClearAnomaly) addBtn('清除異常標記', 'secondary', act('CLEAR_ANOMALY', '確認已處理檔案位置，清除異常標記？'));
          addBtn('人工完成', 'secondary', act('COMPLETE', '確認這份文件已在系統外處理完成？'));
          addBtn('結束', 'danger', act('END', '結束這份文件？不會標示成功。'));
          tr.appendChild(op); t.appendChild(tr);
        });
        box.appendChild(t);
      }
      if (d.permissions.length) {
        box.appendChild(el('div', { class: 'card-title', style: 'margin-top:16px' }, '雲端權限異常（' + d.permissions.length + '）'));
        var t2 = el('table');
        var h2 = el('tr'); ['對象', '帳號', '資料夾', '狀態', '錯誤', '操作'].forEach(function (x) { h2.appendChild(el('th', {}, x)); }); t2.appendChild(h2);
        d.permissions.forEach(function (p) {
          var tr = el('tr');
          tr.appendChild(el('td', {}, (p.type === 'ADMIN' ? '管理員 ' : '客戶 ') + p.who));
          tr.appendChild(el('td', {}, p.email));
          tr.appendChild(el('td', {}, p.company));
          tr.appendChild(el('td', {}, p.status === 'SYNC_FAILED' ? '授權失敗' : '撤銷停滯'));
          tr.appendChild(el('td', {}, p.lastError));
          var op = el('td');
          var b = el('button', { class: 'btn small' }, p.status === 'SYNC_FAILED' ? '重新同步' : '重試撤銷');
          b.onclick = function () { call(p.type === 'ADMIN' ? 'retryAdminPermission' : 'retryPermission', { permissionId: p.permissionId }, loadExceptions); };
          op.appendChild(b); tr.appendChild(op); t2.appendChild(tr);
        });
        box.appendChild(t2);
      }
      if (d.takeoverItems.length) {
        box.appendChild(el('div', { class: 'card-title', style: 'margin-top:16px' }, '檔案移交失敗（' + d.takeoverItems.length + '）'));
        var t3 = el('table');
        var h3 = el('tr'); ['項目', '類型', '原擁有者', '錯誤', '操作'].forEach(function (x) { h3.appendChild(el('th', {}, x)); }); t3.appendChild(h3);
        d.takeoverItems.forEach(function (x) {
          var tr = el('tr');
          tr.appendChild(el('td', {}, x.name));
          tr.appendChild(el('td', {}, x.itemType === 'FOLDER' ? '資料夾' : '檔案'));
          tr.appendChild(el('td', {}, x.email));
          tr.appendChild(el('td', {}, x.error.slice(0, 120)));
          var op = el('td');
          var r1 = el('button', { class: 'btn small' }, '重試'); r1.onclick = function () { call('takeoverItemAction', { takeoverItemId: x.takeoverItemId, kind: 'RETRY' }, loadExceptions); };
          var r2 = el('button', { class: 'btn small secondary' }, '已人工處理');
          r2.onclick = function () { if (confirm('確認這個項目已在 Google 雲端硬碟手動處理完成？')) call('takeoverItemAction', { takeoverItemId: x.takeoverItemId, kind: 'DONE' }, loadExceptions); };
          op.appendChild(r1); op.appendChild(r2); tr.appendChild(op); t3.appendChild(tr);
        });
        box.appendChild(t3);
      }
    }, function (err) { $('excBox').textContent = err.message; });
  }

  /* ---------- 非事務所擁有的檔案與檔案移交（8.3；僅超級管理員） ---------- */
  var TAKEOVER_STATUS = { PENDING: '等待處理', PROCESSING: '處理中', COMPLETED: '完成', COMPLETED_WITH_ERRORS: '完成（有失敗項目）' };
  var TAKEOVER_REASON = { ADMIN_SUSPENDED: '停用管理員', EMAIL_CHANGED: '更換 Google 帳號', SCOPE_REMOVED: '移出負責公司', MANUAL: '手動執行' };

  function loadTakeover() {
    $('takeBox').textContent = '載入中（需查詢 Google 雲端硬碟，可能要幾秒）…';
    call('takeoverReport', {}, function (d) {
      var box = $('takeBox'); box.innerHTML = '';
      box.appendChild(el('div', { class: 'card-title' }, '各管理員在公司資料夾內擁有的項目'));
      var t = el('table');
      var h = el('tr'); ['管理員', 'Google 帳號', '項目數', '分布', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      d.admins.forEach(function (a) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, a.name + (a.status === 'SUSPENDED' ? '（已停用）' : '')));
        tr.appendChild(el('td', {}, a.email));
        tr.appendChild(el('td', {}, a.error ? '查詢失敗' : a.total + '（含 ' + a.folders + ' 個資料夾）'));
        tr.appendChild(el('td', {}, a.byCompany.map(function (c) { return c.name + ' ' + c.count; }).join('、') || '—'));
        var op = el('td');
        if (a.inProgress) op.appendChild(badge('移交進行中', 'warn'));
        else if (a.total > 0) {
          var b = el('button', { class: 'btn small' }, '執行移交');
          b.onclick = function () {
            if (confirm('確定把「' + a.name + '」擁有的 ' + a.total + ' 個項目移交給系統帳號？\n檔案會改為系統帳號擁有的同名複本（原檔的版本紀錄與留言不保留）。')) {
              call('manualTakeover', { adminId: a.adminId, companyId: '' }, function () { alert('已排入背景處理，完成後這裡會顯示紀錄。'); loadTakeover(); });
            }
          };
          op.appendChild(b);
        }
        tr.appendChild(op); t.appendChild(tr);
      });
      box.appendChild(t);
      box.appendChild(el('div', { class: 'card-title', style: 'margin-top:16px' }, '最近的移交紀錄'));
      if (!d.history.length) { box.appendChild(el('div', { class: 'muted' }, '尚無移交紀錄。')); return; }
      var t2 = el('table');
      var h2 = el('tr'); ['時間', '管理員', '原因', '範圍', '狀態', '結果'].forEach(function (x) { h2.appendChild(el('th', {}, x)); }); t2.appendChild(h2);
      d.history.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, fmtTime(x.createdAt)));
        tr.appendChild(el('td', {}, x.admin));
        tr.appendChild(el('td', {}, TAKEOVER_REASON[x.reason] || x.reason));
        tr.appendChild(el('td', {}, x.company));
        tr.appendChild(el('td', {}, TAKEOVER_STATUS[x.status] || x.status));
        tr.appendChild(el('td', {}, '成功 ' + x.done + ' ／ 失敗 ' + x.failed + ' ／ 共 ' + x.total));
        t2.appendChild(tr);
      });
      box.appendChild(t2);
    }, function (err) { $('takeBox').textContent = err.message; });
  }

  /* ---------- 批次匯入公司（僅超級管理員） ---------- */
  var IMP_STATE = { NEW: '將建立', EXISTS: '已登記，略過', ERROR: '有問題' };
  var IMP_RESULT = { CREATED: '已建立', SKIPPED: '略過', ERROR: '失敗', PENDING: '尚未處理' };

  function impRows() {
    return $('impText').value.split(/\r?\n/).map(function (line) {
      var p = line.split(/\t|,/).map(function (x) { return x.trim(); });
      return { companyId: p[0] || '', fullName: p[1] || '', name: p[2] || '' };
    }).filter(function (r) { return r.companyId || r.fullName || r.name; }).filter(function (r) { return !/^(統編|id)$/i.test(r.companyId); });
  }
  function impArgs() { return { rows: impRows(), parent: $('impParent').value.trim(), limit: Number($('impLimit').value) || 0 }; }

  function impTable(heads, rows) {
    var t = el('table'); var h = el('tr');
    heads.forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
    rows.forEach(function (r) { var tr = el('tr'); r.forEach(function (c) { tr.appendChild(el('td', {}, c)); }); t.appendChild(tr); });
    return t;
  }

  function previewImport() {
    var box = $('impBox'); $('impRun').disabled = true;
    if (!impRows().length) { box.textContent = '請先貼上清單。'; return; }
    box.textContent = '檢查中…';
    call('previewCompanyImport', impArgs(), function (d) {
      box.innerHTML = '';
      box.appendChild(el('div', {}, '資料夾將建立在：' + d.parentName + '。共 ' + d.counts.total + ' 筆：將建立 ' + d.counts.create + '、已登記略過 ' + d.counts.exists + '、有問題 ' + d.counts.error + '。'));
      if (d.parentSharedWith > 0) box.appendChild(el('div', { class: 'error' }, '注意：上層資料夾「' + d.parentName + '」有分享給其他人（' + d.parentSharedWith + ' 位），新資料夾會繼承那些人的存取權。請先確認。'));
      box.appendChild(impTable(['統編', '全名', '簡稱', '資料夾', '狀態'], d.items.map(function (i) {
        return [i.companyId, i.fullName, i.name, i.folder ? i.folder + (i.reuse ? '（沿用既有）' : '') : '', (IMP_STATE[i.state] || i.state) + (i.reason && i.state === 'ERROR' ? '：' + i.reason : '')];
      })));
      $('impRun').disabled = d.counts.create === 0;
    }, function (err) { box.textContent = err.message; });
  }

  function runImport() {
    var args = impArgs();
    if (!confirm('確定開始匯入？系統會建立資料夾並新增公司（' + (args.limit ? '只處理前 ' + args.limit + ' 家' : '全部') + '）。')) return;
    var box = $('impBox'); $('impRun').disabled = true;
    box.textContent = '匯入中，請勿關閉頁面…（每家約數秒，單次最多約 4 分鐘；若顯示尚未處理，再按一次即可繼續）';
    call('importCompanies', args, function (d) {
      box.innerHTML = '';
      box.appendChild(el('div', {}, '完成：建立 ' + d.created + '、略過 ' + d.skipped + '、失敗 ' + d.errors + '、尚未處理 ' + d.pending + '。'));
      box.appendChild(impTable(['統編', '簡稱', '結果', '說明'], d.results.map(function (r) { return [r.companyId, r.name, IMP_RESULT[r.result] || r.result, r.message || '']; })));
    }, function (err) { box.textContent = err.message; });
  }
  $('impPreview').onclick = previewImport;
  $('impRun').onclick = runImport;

  /* ---------- 客戶上傳文件（僅超級管理員） ---------- */
  function loadIntake() {
    var box = $('intakeBox'); box.textContent = '載入中…';
    call('listIntake', { includeDone: $('intakeShowDone').checked }, function (d) {
      $('intakeSetup').classList.toggle('hidden', d.enabled);
      box.innerHTML = '';
      if (!d.enabled) { box.appendChild(el('div', { class: 'muted' }, '尚未啟用。按上方「啟用客戶上傳文件」，系統會在雲端硬碟建立「客戶上傳文件」資料夾（與「客戶資料」同一層、不分享給任何人），之後客戶傳來的檔案都會存到這裡。')); return; }
      if (d.rootUrl) { var a = el('a', { href: d.rootUrl, target: '_blank', rel: 'noopener' }, '開啟「客戶上傳文件」總資料夾'); var p = el('div', { style: 'margin-bottom:10px' }); p.appendChild(a); box.appendChild(p); }
      if (d.usage) {
        var u = d.usage;
        box.appendChild(el('div', { class: u.percent >= 70 ? 'warn' : 'muted', style: 'margin-bottom:10px' },
          '雲端切邊轉正（GitHub）本月預估用量：約 ' + u.estMinutes + ' ／ ' + u.limit + ' 分鐘（' + u.percent + '%）｜檢查 ' + u.checks + ' 次、處理 ' + u.runs + ' 次' +
          (u.percent >= 70 ? '　⚠ 接近免費額度，請到 GitHub 的 Settings → Billing 確認實際用量' : '')));
      }
      if (d.queued) box.appendChild(el('div', { class: 'warn', style: 'margin-bottom:10px' }, '⚠ 目前還有 ' + d.queued + ' 張照片正在傳送或整理中，尚未進資料夾；下方數字可能還會增加。'));
      if (!d.items.length) { box.appendChild(el('div', { class: 'muted' }, '目前沒有待處理的客戶上傳文件。')); return; }
      var t = el('table'); var h = el('tr');
      ['公司', '月份', '檔案數', '已自動後製', '需人工確認', '最近收到', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      d.items.forEach(function (i) {
        var tr = el('tr');
        var recent = i.lastReceivedAt && (Date.now() - new Date(i.lastReceivedAt).getTime()) < 3 * 60000;
        var tdc = el('td', {}, i.company);
        if (i.addedAfterDone) tdc.appendChild(el('div', { style: 'color:#1d4ed8;font-weight:600;font-size:12px' }, '已處理後又新增 ' + i.addedAfterDone + ' 份'));
        tr.appendChild(tdc); tr.appendChild(el('td', {}, i.month)); tr.appendChild(el('td', {}, String(i.files)));
        var st = el('td', {}, i.processed + ' ／ ' + i.files);
        if (i.unprocessed) st.appendChild(el('div', { class: 'warn' }, '尚有 ' + i.unprocessed + ' 份未處理'));
        tr.appendChild(st);
        tr.appendChild(el('td', {}, i.review ? String(i.review) : '—'));
        var rt = el('td', {}, fmtTime(i.lastReceivedAt));
        if (recent) rt.appendChild(el('div', { class: 'warn' }, '客戶可能還在傳'));
        tr.appendChild(rt);
        var op = el('td');
        var open = el('a', { class: 'btn small', href: i.url, target: '_blank', rel: 'noopener' }, '開啟資料夾'); op.appendChild(open);
        var b = el('button', { class: 'btn small secondary', style: 'margin-left:6px' }, i.status === 'DONE' ? '改回待處理' : '標記已處理');
        b.onclick = function () {
          if (i.status !== 'DONE') {
            var warns = [];
            if (i.unprocessed) warns.push('還有 ' + i.unprocessed + ' 份尚未自動處理');
            if (recent) warns.push('客戶 3 分鐘內還有新檔案進來');
            if (d.queued) warns.push('系統內還有 ' + d.queued + ' 張照片正在傳送或整理中');
            if (warns.length && !confirm('確定標記為已處理嗎？\n\n' + warns.join('\n'))) return;
          }
          call('markIntakeDone', { intakeMonthId: i.intakeMonthId, done: i.status !== 'DONE' }, loadIntake);
        };
        op.appendChild(b); tr.appendChild(op); t.appendChild(tr);
      });
      box.appendChild(t);
    }, function (err) { box.textContent = err.message; });
  }
  $('intakeReload').onclick = loadIntake;
  $('intakeShowDone').onchange = loadIntake;
  $('intakeSetup').onclick = function () {
    if (!confirm('要在雲端硬碟建立「客戶上傳文件」資料夾並啟用嗎？\n啟用後，客戶傳來的新檔案會存到這裡（客戶看不到），不再放進公司資料夾。')) return;
    call('intakeSetup', {}, function (r) { alert('已啟用：' + r.folderName); loadIntake(); });
  };

  $('intakeSyncPerms').onclick = function () {
    if (!confirm('依每位管理員的負責公司，重新授權他們可以打開的「客戶上傳文件」資料夾嗎？\n（超級管理員可打開全部；一般管理員只能打開自己負責的公司。）')) return;
    call('intakeSyncPerms', {}, function (r) {
      alert(r.enabled ? '已完成：共 ' + r.folders + ' 個公司資料夾，新增或調整了 ' + r.changed + ' 筆授權。實際授權會由背景處理在幾分鐘內完成。' : '尚未啟用客戶上傳文件。');
    });
  };

  /* ---------- 系統備份（僅超級管理員） ---------- */
  var backupData = null;
  function loadBackup() {
    var box = $('backupBox'); box.textContent = '載入中…';
    call('listBackups', {}, function (d) {
      backupData = d;
      $('backupSetup').classList.toggle('hidden', !!d.enabled);
      $('backupNow').classList.toggle('hidden', !d.enabled);
      $('backupDownload').classList.toggle('hidden', !d.enabled);
      $('backupRestoreCard').classList.toggle('hidden', !d.enabled);
      box.innerHTML = '';
      if (!d.enabled) { box.appendChild(el('div', { class: 'muted' }, '尚未啟用。按上方「啟用系統備份」，系統會在雲端硬碟建立「系統備份」資料夾（與「客戶資料」同一層、不分享給任何人），之後每天自動備份。')); return; }
      var h = d.home || {};
      var p = el('div', { style: 'margin-bottom:10px' });
      p.appendChild(el('a', { href: d.rootUrl, target: '_blank', rel: 'noopener' }, '開啟「系統備份」資料夾'));
      box.appendChild(p);
      if (d.last) box.appendChild(el('div', { class: d.last.failed ? 'err' : 'muted', style: 'margin-bottom:6px' }, '最近一次備份：' + fmtTime(d.last.at) + '｜' + (d.last.failed ? '有失敗' : '成功') + '｜' + d.last.message));
      else box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' }, '尚未執行過備份，系統會在今天的每日工作自動執行，也可按「立即備份一次」。'));
      box.appendChild(el('div', { class: h.ackOverdue ? 'warn' : 'muted', style: 'margin-bottom:10px' },
        '上次下載到地端：' + (h.ackAt ? fmtTime(h.ackAt) : '尚未記錄') + (h.ackOverdue ? '（已超過 35 天，請把「系統備份」資料夾下載到地端電腦，再按「已下載到地端」）' : '') + '｜' + d.keepNote));
      var t = el('table'); var hr = el('tr');
      ['備份', '種類', '建立時間', '開啟'].forEach(function (x) { hr.appendChild(el('th', {}, x)); }); t.appendChild(hr);
      var KIND = { DB: '資料庫', TAX: '稅務資料', INV: '檔案清單', SNAPSHOT: '還原前快照' };
      d.items.forEach(function (i) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, i.name)); tr.appendChild(el('td', {}, KIND[i.type] || i.type)); tr.appendChild(el('td', {}, fmtTime(i.createdAt)));
        var td = el('td'); td.appendChild(el('a', { href: i.url, target: '_blank', rel: 'noopener' }, '開啟')); tr.appendChild(td); t.appendChild(tr);
      });
      box.appendChild(t);
      var fsel = $('backupRestoreFile'); fsel.innerHTML = '';
      d.items.filter(function (i) { return i.type === 'DB' || i.type === 'TAX'; }).forEach(function (i) { fsel.appendChild(el('option', { value: i.id }, i.name)); });
      fillRestoreTables();
    }, function (err) { box.textContent = err.message; });
  }
  function fillRestoreTables() {
    var tsel = $('backupRestoreTable'); tsel.innerHTML = '';
    if (!backupData || !backupData.tables) return;
    var opt = $('backupRestoreFile').selectedOptions[0];
    var isLog = opt && opt.textContent.indexOf('日誌庫') === 0, isTax = opt && opt.textContent.indexOf('稅務資料') === 0;
    backupData.tables.filter(function (x) { return isTax ? x.db === 'tax' : (isLog ? x.db === 'log' : x.db === 'main'); }).forEach(function (x) { tsel.appendChild(el('option', { value: x.name }, x.name)); });
  }
  $('backupRestoreFile').onchange = fillRestoreTables;
  $('backupReload').onclick = loadBackup;
  $('backupSetup').onclick = function () {
    if (!confirm('要在雲端硬碟建立「系統備份」資料夾並啟用嗎？\n（與「客戶資料」同一層，不分享給任何人；之後每天自動備份）')) return;
    call('backupSetup', {}, function (r) { alert('已啟用：' + r.folderName); loadBackup(); });
  };
  $('backupNow').onclick = function () {
    var b = $('backupNow'); b.disabled = true; b.textContent = '備份中…（約需 1 分鐘）';
    call('backupNow', {}, function (r) { b.disabled = false; b.textContent = '立即備份一次'; alert((r.failed ? '有失敗：' : '完成：') + r.messages.join('\n')); loadBackup(); },
      function (err) { b.disabled = false; b.textContent = '立即備份一次'; alert(err.message); });
  };
  $('backupDownload').onclick = runBackupDownload;
  function runBackupDownload() {
    var b = $('backupDownload'); b.disabled = true; b.textContent = '準備中…（約需 30 秒）';
    var reset = function () { b.disabled = false; b.textContent = '一鍵下載到地端（ZIP）'; };
    call('backupDownload', {}, function (r) {
      try {
        var bin = atob(r.base64), n = bin.length, bytes = new Uint8Array(n);
        for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        var a = document.createElement('a'); a.href = url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      } catch (e) { reset(); alert('下載失敗：' + e.message); return; }
      reset();
      alert('已下載「' + r.name + '」（含 ' + r.included.join('、') + '）。\n請把這個檔案存放在安全的位置（內含客戶資料）。' + (r.skipped.length ? '\n\n注意：以下沒有放進 ZIP：\n' + r.skipped.join('\n') : ''));
      loadBackup();
    }, function (err) { reset(); alert(err.message); });
  }

  /** 登入後（每個瀏覽器工作階段一次）：備份逾期或失敗時跳出提醒；只有超級管理員的首頁資料帶有 backup，所以一般管理員不會看到 */
  function backupReminder(bk) {
    if (!bk || !bk.enabled || !(bk.ackOverdue || bk.lastFailed)) return;
    try { if (sessionStorage.getItem('yc_backup_popup')) return; sessionStorage.setItem('yc_backup_popup', '1'); } catch (e) { /* 無法記錄時照常顯示 */ }
    var ov = el('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px' });
    var box = el('div', { style: 'background:#fff;color:#1a2433;border-radius:10px;max-width:460px;width:100%;padding:22px;box-shadow:0 10px 40px rgba(0,0,0,.3)' });
    box.appendChild(el('div', { style: 'font-size:18px;font-weight:700;margin-bottom:10px' }, bk.lastFailed ? '⚠ 系統備份失敗' : '⚠ 該下載系統備份了'));
    box.appendChild(el('div', { style: 'line-height:1.7;margin-bottom:16px;white-space:pre-line' },
      (bk.lastFailed ? '最近一次自動備份失敗，請到「備份」頁查看原因，或按「立即備份一次」。' : '') +
      (bk.ackOverdue ? (bk.lastFailed ? '\n' : '') + '已經 ' + bk.daysSinceAck + ' 天沒有把系統備份下載到地端電腦。這份備份是 Google 帳號出問題時的最後保障，請按下方按鈕下載（約 30 秒，ZIP 內含客戶資料，請存放在安全的位置）。' : '')));
    var row = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap' });
    var later = el('button', { class: 'btn secondary' }, '稍後再說');
    later.onclick = function () { ov.remove(); };
    var go2 = el('button', { class: 'btn' }, bk.ackOverdue ? '立即下載' : '前往備份頁');
    go2.onclick = function () { ov.remove(); go('backup'); if (bk.ackOverdue) setTimeout(runBackupDownload, 400); };
    row.appendChild(later); row.appendChild(go2); box.appendChild(row); ov.appendChild(box); document.body.appendChild(ov);
  }
  $('backupRestoreGo').onclick = function () {
    var fileId = $('backupRestoreFile').value, table = $('backupRestoreTable').value, mode = $('backupRestoreMode').value;
    if (!fileId || !table) { alert('請選擇備份與資料表'); return; }
    var confirmText = '';
    if (mode === 'replace') {
      var isTaxFile = $('backupRestoreFile').selectedOptions[0].textContent.indexOf('稅務資料') === 0;
      confirmText = prompt('您要用「' + $('backupRestoreFile').selectedOptions[0].textContent + '」取代現行的「' + table + '」資料表。\n系統會先把現行' + (isTaxFile ? '這張資料表' : '試算表') + '另存到「還原前快照」。\n\n請輸入「還原」二字確認：') || '';
      if (confirmText !== '還原') { alert('已取消'); return; }
    }
    call('backupRestoreTable', { fileId: fileId, table: table, mode: mode, confirm: confirmText }, function (r) {
      if (r.mode === 'preview' && r.backupRows !== undefined) {
        alert('「' + r.table + '」預覽（現行資料沒有變動）：\n備份 ' + r.backupRows + ' 列、現行 ' + r.currentRows + ' 列\n只在備份裡：' + r.onlyInBackup + ' 列（還原後會出現）\n只在現行：' + r.onlyInCurrent + ' 列（還原後會消失）\n內容不同：' + r.changed + ' 列（還原後會變回備份的內容）');
        return;
      }
      alert(r.mode === 'preview' ? '已在現行試算表新增分頁「' + r.sheet + '」（' + r.rows + ' 列），請到試算表檢視，現行資料沒有變動。' : '已還原 ' + r.rows + ' 列；還原前的試算表已另存為「' + r.snapshot + '」。');
    });
  };

  /* ---------- 雲端硬碟檢查（僅超級管理員） ---------- */
  var DA_KIND = { EXTRA: '多餘的分享', ROLE_HIGH: '權限過高', OPEN_LINK: '連結公開', MISSING: '應有但雲端沒有' };
  var DA_ROLE = { reader: '檢視者', commenter: '留言者', writer: '編輯者', fileOrganizer: '內容管理員', organizer: '管理員' };

  function runDriveAudit() {
    var box = $('driveAuditBox');
    box.textContent = '檢查中（需逐一查詢 Google 雲端硬碟，可能要一分鐘左右，請勿關閉頁面）…';
    call('driveAudit', {}, function (d) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'muted' }, '已檢查 ' + d.checkedFolders + ' 個資料夾，時間 ' + fmtTime(d.checkedAt)));
      d.errors.forEach(function (m) { box.appendChild(el('div', { class: 'error' }, m)); });
      box.appendChild(el('div', { class: 'card-title', style: 'margin-top:12px' }, '分享對象與系統記錄不符（' + d.issues.length + '）'));
      if (!d.issues.length) box.appendChild(el('div', { class: 'muted' }, '全部相符。'));
      else {
        var t = el('table');
        var h = el('tr'); ['資料夾', '對象', '問題', '雲端現況', '系統記錄應為', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
        d.issues.forEach(function (i) {
          var tr = el('tr');
          tr.appendChild(el('td', {}, i.folderName));
          tr.appendChild(el('td', {}, i.who));
          tr.appendChild(el('td', {}, DA_KIND[i.kind] || i.kind));
          tr.appendChild(el('td', {}, DA_ROLE[i.role] || i.role || '—'));
          tr.appendChild(el('td', {}, DA_ROLE[i.expected] || i.expected || '無'));
          var op = el('td');
          if (i.kind === 'EXTRA' || i.kind === 'OPEN_LINK') {
            var b = el('button', { class: 'btn small' }, '移除分享');
            b.onclick = function () {
              if (confirm('確定移除「' + i.who + '」對「' + i.folderName + '」的分享？\n移除後對方就無法再開啟此資料夾。')) fixDriveAudit({ kind: 'REMOVE_PERMISSION', folderId: i.folderId, permissionId: i.permissionId });
            };
            op.appendChild(b);
          } else if (i.kind === 'ROLE_HIGH') {
            var b2 = el('button', { class: 'btn small' }, '降為' + (DA_ROLE[i.expected] || i.expected));
            b2.onclick = function () { fixDriveAudit({ kind: 'SET_ROLE', folderId: i.folderId, permissionId: i.permissionId }); };
            op.appendChild(b2);
          } else op.appendChild(el('span', { class: 'muted' }, '等背景同步，或到客戶管理按「重試」'));
          tr.appendChild(op); t.appendChild(tr);
        });
        box.appendChild(t);
      }
      box.appendChild(el('div', { class: 'card-title', style: 'margin-top:16px' }, '擁有者不是系統帳號的檔案（' + d.foreign.length + (d.foreignPartial ? '，僅列前 ' + d.foreign.length + ' 筆' : '') + '）'));
      box.appendChild(el('div', { class: 'muted' }, '管理員擁有的檔案請到「非事務所擁有的檔案」頁處理；這裡是客戶或其他人擁有的檔案。'));
      if (!d.foreign.length) box.appendChild(el('div', { class: 'muted' }, '沒有。'));
      else {
        var t2 = el('table');
        var h2 = el('tr'); ['檔名', '所在', '擁有者', '操作'].forEach(function (x) { h2.appendChild(el('th', {}, x)); }); t2.appendChild(h2);
        d.foreign.forEach(function (f) {
          var tr = el('tr');
          tr.appendChild(el('td', {}, f.name + (f.isFolder ? '（資料夾）' : '')));
          tr.appendChild(el('td', {}, f.where));
          tr.appendChild(el('td', {}, f.owner));
          var op = el('td');
          if (f.isFolder) op.appendChild(el('span', { class: 'muted' }, '請在雲端硬碟手動處理'));
          else {
            var b3 = el('button', { class: 'btn small' }, '改為系統帳號擁有');
            b3.onclick = function () {
              if (confirm('把「' + f.name + '」複製為系統帳號擁有的同名檔案，並把原檔移出？\n原檔的版本紀錄與留言不保留。')) fixDriveAudit({ kind: 'FOREIGN_FILE', fileId: f.fileId });
            };
            op.appendChild(b3);
          }
          tr.appendChild(op); t2.appendChild(tr);
        });
        box.appendChild(t2);
      }
    }, function (err) { box.textContent = err.message; });
  }

  function fixDriveAudit(args) {
    call('driveAuditFix', args, function (r) { alert(r.message || '完成'); runDriveAudit(); });
  }
  $('driveAuditRun').onclick = runDriveAudit;

  /* ---------- 稽核紀錄（僅超級管理員） ---------- */
  var auditOffset = 0;
  function loadAudit(more) {
    if (!more) { auditOffset = 0; $('auditBox').innerHTML = ''; }
    var args = { from: $('auditFrom').value, to: $('auditTo').value, action: $('auditAction').value, actor: $('auditActor').value, offset: auditOffset };
    call('listAudit', args, function (d) {
      var box = $('auditBox');
      var t = box.querySelector('table');
      if (!t) {
        t = el('table');
        var h = el('tr'); ['時間', '操作者', '動作', '公司', '對象', '結果', '細節'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
        box.innerHTML = ''; box.appendChild(t);
      }
      d.records.forEach(function (r) {
        var tr = el('tr');
        [fmtTime(r.time), r.actor, r.action, r.company, r.target, r.result, r.context].forEach(function (v, i) { tr.appendChild(el('td', i === 6 ? { style: 'word-break:break-all;font-size:12px' } : {}, String(v || ''))); });
        t.appendChild(tr);
      });
      auditOffset += d.records.length;
      $('auditCount').textContent = '符合條件共 ' + d.total + ' 筆，已顯示 ' + auditOffset + ' 筆';
      $('auditMore').classList.toggle('hidden', auditOffset >= d.total);
      if (!d.total) box.textContent = '沒有符合條件的紀錄。';
    }, function (err) { $('auditBox').textContent = err.message; });
  }
  $('auditSearch').onclick = function () { loadAudit(false); };
  $('auditMore').onclick = function () { loadAudit(true); };

  function setNavCount(id, n) { $(id).textContent = n ? String(n) : ''; }

  /* ---------- 邀請管理（第六章） ---------- */
  var INVITE_STATUS = { ACTIVE: ['可使用', 'ok'], USED: ['已使用', ''], EXPIRED: ['已過期', 'off'], REVOKED: ['已撤銷', 'off'] };
  var invData = null;

  function loadInvites() {
    $('inviteBox').textContent = '載入中…';
    call('listInvites', {}, function (d) {
      invData = d;
      var box = $('inviteBox'); box.innerHTML = '';
      if (!d.invites.length) { box.appendChild(el('div', { class: 'muted' }, '尚未建立任何邀請連結。')); return; }
      var isSuper = me && me.role === 'SUPER_ADMIN';
      var deletable = d.invites.filter(function (i) { return i.status === 'EXPIRED' || i.status === 'REVOKED'; });
      if (isSuper && deletable.length) {
        var pb = el('button', { class: 'btn small danger', style: 'margin-bottom:10px' }, '清除已撤銷／已過期的邀請（' + deletable.length + ' 筆）');
        pb.onclick = function () {
          if (!confirm('要刪除全部 ' + deletable.length + ' 筆已撤銷或已過期的邀請嗎？（可使用與已使用的不會刪）')) return;
          pb.disabled = true; call('purgeInvites', {}, function (r) { alert('已刪除 ' + r.removed + ' 筆'); loadInvites(); }, function (e) { pb.disabled = false; alert(e.message); });
        };
        box.appendChild(pb);
      }
      var t = el('table');
      var cg = el('colgroup'); ['', '120px', '120px', '80px', '', '90px', '100px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
      var h = el('tr'); ['公司', '建立時間', '到期時間', '狀態', '使用者', '建立者', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      d.invites.forEach(function (i) {
        var tr = el('tr', i.status === 'ACTIVE' ? {} : { class: 'dim' });
        tr.appendChild(el('td', {}, i.companyName));
        tr.appendChild(el('td', {}, fmtTime(i.createdAt)));
        tr.appendChild(el('td', {}, fmtTime(i.expireAt)));
        var s = INVITE_STATUS[i.status] || [i.status, '']; var c = el('td'); c.appendChild(badge(s[0], s[1])); tr.appendChild(c);
        tr.appendChild(el('td', {}, i.usedBy ? i.usedBy + '（' + fmtTime(i.usedAt) + '）' : ''));
        tr.appendChild(el('td', {}, i.createdBy));
        var op = el('td');
        if (i.status === 'ACTIVE') {
          var vw = el('button', { class: 'btn small secondary', style: 'margin-right:6px' }, '查看連結');
          vw.onclick = function () { vw.disabled = true; call('getInviteLink', { inviteId: i.inviteId }, function (r) { vw.disabled = false; showInvite(r, '邀請連結'); }, function (e) { vw.disabled = false; alert(e.message); }); };
          op.appendChild(vw);
          var r = el('button', { class: 'btn small danger' }, '撤銷');
          r.onclick = function () { if (confirm('確定撤銷「' + i.companyName + '」的邀請連結？撤銷後客戶將無法使用。')) call('revokeInvite', { inviteId: i.inviteId }, loadInvites); };
          op.appendChild(r);
        } else if (i.status === 'EXPIRED' || i.status === 'REVOKED') {
          var again = el('button', { class: 'btn small secondary' }, '重新建立');
          again.onclick = function () { createInvite(i.companyId); };
          op.appendChild(again);
          if (isSuper) {
            var del = el('button', { class: 'btn small danger', style: 'margin-left:6px' }, '刪除');
            del.onclick = function () { if (confirm('確定刪除這筆「' + i.companyName + '」的邀請紀錄？')) call('deleteInvite', { inviteId: i.inviteId }, loadInvites, function (e) { alert(e.message); }); };
            op.appendChild(del);
          }
        }
        tr.appendChild(op);
        t.appendChild(tr);
      });
      box.appendChild(t);
    }, function (err) { $('inviteBox').textContent = err.message; });
  }

  $('addInviteBtn').onclick = function () {
    var open = function () {
      var m = openModal('建立邀請連結');
      if (!invData.companies.length) {
        m.appendChild(el('div', { class: 'muted' }, '沒有可建立邀請的公司（需為啟用中且在您的負責範圍）。'));
        var bar = el('div', { class: 'actions' }); var close = el('button', { class: 'btn secondary' }, '關閉'); close.onclick = closeModal; bar.appendChild(close); m.appendChild(bar);
        return;
      }
      var q = field(m, '搜尋公司', el('input', { type: 'text', placeholder: '輸入統編或公司名稱' }));
      var sel = field(m, '選擇公司', el('select', { size: '8' }));
      var fill = function () {
        var k = q.value.trim().toLowerCase(); sel.innerHTML = '';
        invData.companies.filter(function (c) { return !k || (c.name + ' ' + c.companyId).toLowerCase().indexOf(k) >= 0; }).forEach(function (c) {
          sel.appendChild(el('option', { value: c.companyId }, c.name + '（' + c.companyId + '）'));
        });
      };
      q.addEventListener('input', fill); fill();
      modalActions(m, '建立', function (fail) {
        if (!sel.value) return fail('請選擇公司');
        createInvite(sel.value, fail);
      });
    };
    if (invData) open(); else call('listInvites', {}, function (d) { invData = d; open(); });
  };

  function createInvite(companyId, fail) {
    call('createInvite', { companyId: companyId }, function (r) { showInvite(r, '邀請連結已建立'); }, function (e) { if (fail) fail(e.message); else alert(e.message); });
  }

  function showInvite(r, title) {
    var m = openModal(title);
    m.appendChild(el('div', {}, '公司：' + r.companyName));
    var copyTo = function (btn, text, label) {
      var done = function () { btn.textContent = '已複製 ✓'; setTimeout(function () { btn.textContent = label; }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { document.execCommand('copy'); done(); });
      else { document.execCommand('copy'); done(); }
    };
    var msgText = r.oaUrl
      ? '您好，請依下列兩步驟完成綁定：' + String.fromCharCode(10) + '1. 先加入我們的官方帳號：' + r.oaUrl + String.fromCharCode(10) + '2. 再點這個連結綁定公司（只能使用一次）：' + r.url
      : r.url;
    var ta = el('textarea', { rows: r.oaUrl ? '5' : '3', readonly: 'readonly', style: 'width:100%;margin-top:8px' }); ta.value = msgText;
    var cp = el('button', { class: 'btn' }, '複製訊息');
    cp.onclick = function () { ta.select(); copyTo(cp, msgText, '複製訊息'); };
    m.appendChild(el('p', { class: 'muted' }, '有效期限至 ' + fmtTime(r.expireAt) + '，只能使用一次。連結在過期或客戶綁定前，隨時可在邀請清單按「查看連結」再取得。'));
    m.appendChild(ta); m.appendChild(cp);
    var bar = el('div', { class: 'actions' }); var close = el('button', { class: 'btn secondary' }, '關閉');
    close.onclick = function () { closeModal(); loadInvites(); }; bar.appendChild(close); m.appendChild(bar);
  }

  /* ---------- 管理員管理 ---------- */
  var adminData = null;

  function loadAdmins() {
    $('adminBox').textContent = '載入中…';
    call('listAdmins', {}, function (d) { adminData = d; renderAdmins(d); },
      function (err) { $('adminBox').textContent = err.message; });
  }

  function companySummary(ids, names) {
    if (!ids.length) return '（無）';
    var shown = ids.slice(0, 3).map(function (id) { return names[id] || id; }).join('、');
    return ids.length > 3 ? shown + ' 等 ' + ids.length + ' 家' : shown;
  }

  function emailCell(a) {
    var box = el('div');
    var v = a.emailVerification;
    var pending = v && v.status === 'PENDING';
    if (a.googleEmail) { box.appendChild(el('div', {}, a.googleEmail)); box.appendChild(badge('已驗證', 'ok')); }
    if (pending) {
      if (a.googleEmail) box.appendChild(el('div', { class: 'muted', style: 'margin-top:4px' }, '變更中：'));
      box.appendChild(el('div', {}, v.email));
      box.appendChild(v.expired ? badge('已過期', 'err') : badge(a.status === 'INVITED' ? '等待接受邀請' : '待本人確認', 'warn'));
      if (v.failedAttempts > 0) box.appendChild(el('div', { class: 'msg err' }, '有非本人嘗試確認（' + v.failedAttempts + ' 次），請檢查 Google 帳號是否填錯'));
    } else if (!a.googleEmail) {
      box.appendChild(badge('未設定', 'off'));
    }
    if (a.status === 'INVITED') {
      var r = el('button', { class: 'btn small secondary', style: 'margin-left:6px' }, '重寄邀請');
      r.onclick = function () { emailDialog(a, 'resend'); };
      box.appendChild(r);
    } else if (a.status === 'ACTIVE') {
      var b = el('button', { class: 'btn small secondary', style: 'margin-left:6px' }, pending ? '重寄確認信' : (a.googleEmail ? '變更' : '設定'));
      b.onclick = function () { emailDialog(a, 'change'); };
      box.appendChild(b);
    }
    return box;
  }

  var showSuspended = false;

  function renderAdmins(d) {
    var box = $('adminBox'); box.innerHTML = '';
    var suspended = d.admins.filter(function (a) { return a.status === 'SUSPENDED'; }).length;
    if (suspended) {
      var tg = el('button', { class: 'linkbtn', style: 'margin-bottom:8px' }, showSuspended ? '隱藏已停用的管理員' : '顯示已停用的管理員（' + suspended + '）');
      tg.onclick = function () { showSuspended = !showSuspended; renderAdmins(d); };
      box.appendChild(tg);
    }
    var names = {}; d.companies.forEach(function (c) { names[c.companyId] = c.name; });
    var t = el('table');
    var cg = el('colgroup'); ['170px', '', '', '120px', '130px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
    var h = el('tr'); ['姓名／角色', 'Google 帳號', '負責公司', '雲端權限', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
    d.admins.filter(function (a) { return showSuspended || a.status !== 'SUSPENDED'; }).forEach(function (a) {
      var tr = el('tr');
      var c1 = el('td'); c1.appendChild(el('div', { style: 'font-weight:600' }, a.name));
      c1.appendChild(badge(a.role === 'SUPER_ADMIN' ? '超級管理員' : '管理員'));
      if (a.status === 'INVITED') c1.appendChild(badge('邀請中', 'warn'));
      if (a.status === 'SUSPENDED') c1.appendChild(badge('已停用', 'off'));
      if (a.lineDisplayName) c1.appendChild(el('div', { class: 'muted' }, 'LINE：' + a.lineDisplayName));
      tr.appendChild(c1);
      var c2 = el('td'); c2.appendChild(emailCell(a)); tr.appendChild(c2);
      tr.appendChild(el('td', {}, a.role === 'SUPER_ADMIN' ? '全部公司' : companySummary(a.companyIds, names)));
      var dv = a.drive;
      var c4 = el('td');
      if (!a.googleEmail) c4.appendChild(el('span', { class: 'muted' }, a.status === 'INVITED' ? '接受邀請後授權' : '需先驗證 Google 帳號'));
      else {
        c4.appendChild(el('div', {}, '有效 ' + dv.active));
        if (dv.pending) c4.appendChild(badge('待同步 ' + dv.pending, 'warn'));
        if (dv.failed) c4.appendChild(badge('失敗 ' + dv.failed, 'err'));
        if (dv.revoking) c4.appendChild(badge('撤銷中 ' + dv.revoking, 'off'));
      }
      tr.appendChild(c4);
      var op = el('td');
      var b1 = el('button', { class: 'btn small secondary' }, '編輯'); b1.onclick = function () { adminDialog(a); };
      op.appendChild(b1);
      if (a.status === 'INVITED') {
        var bc = el('button', { class: 'btn small danger' }, '取消邀請');
        bc.onclick = function () {
          if (!confirm('確定取消對「' + a.name + '」的邀請？已寄出的邀請連結將失效。')) return;
          call('cancelInvite', { adminId: a.adminId }, loadAdmins);
        };
        op.appendChild(bc);
      } else {
        var b3 = el('button', { class: 'btn small ' + (a.status === 'ACTIVE' ? 'danger' : 'secondary') }, a.status === 'ACTIVE' ? '停用' : '啟用');
        b3.onclick = function () { toggleAdmin(a); };
        op.appendChild(b3);
      }
      tr.appendChild(op);
      t.appendChild(tr);
    });
    box.appendChild(t);
  }

  /** 公司勾選器：可搜尋、固定高度捲動、顯示已選數量 */
  function companyPicker(companies, selected) {
    var wrap = el('div');
    if (!companies.length) { wrap.appendChild(el('div', { class: 'muted' }, '尚未建立公司，可稍後再設定。')); wrap.getChecked = function () { return []; }; return wrap; }
    var bar = el('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px' });
    var q = el('input', { type: 'text', placeholder: '搜尋統編或公司名稱' });
    var count = el('span', { class: 'muted', style: 'white-space:nowrap' });
    bar.appendChild(q); bar.appendChild(count);
    var tools = el('div', { style: 'margin-bottom:6px' });
    var all = el('button', { class: 'btn small secondary', type: 'button' }, '全選目前顯示');
    var none = el('button', { class: 'btn small secondary', type: 'button' }, '全部取消');
    tools.appendChild(all); tools.appendChild(none);
    var list = el('div', { class: 'checks', style: 'max-height:220px;overflow:auto;border:1px solid #dde3ea;border-radius:6px;padding:4px 8px' });
    function update() { count.textContent = '已選 ' + rows.filter(function (r) { return r.cb.checked; }).length + ' 家'; }
    var rows = companies.map(function (c) {
      var lb = el('label'); var cb = el('input', { type: 'checkbox', value: c.companyId });
      cb.checked = selected.indexOf(c.companyId) >= 0;
      lb.appendChild(cb); lb.appendChild(document.createTextNode(c.name + '（' + c.companyId + '）'));
      list.appendChild(lb);
      cb.addEventListener('change', update);
      return { lb: lb, cb: cb, text: (c.name + ' ' + c.companyId).toLowerCase() };
    });
    q.addEventListener('input', function () {
      var k = q.value.trim().toLowerCase();
      rows.forEach(function (r) { r.lb.classList.toggle('hidden', !!k && r.text.indexOf(k) < 0); });
    });
    all.onclick = function () { rows.forEach(function (r) { if (!r.lb.classList.contains('hidden')) r.cb.checked = true; }); update(); };
    none.onclick = function () { rows.forEach(function (r) { r.cb.checked = false; }); update(); };
    update();
    wrap.appendChild(bar); wrap.appendChild(tools); wrap.appendChild(list);
    wrap.getChecked = function () { return rows.filter(function (r) { return r.cb.checked; }).map(function (r) { return r.cb.value; }); };
    return wrap;
  }

  /** 角色、負責公司、功能欄位（新增與編輯共用） */
  function roleFields(m, a) {
    var role = el('select');
    [['ADMIN', '管理員（只能處理負責的公司）'], ['SUPER_ADMIN', '超級管理員（全部權限）']].forEach(function (o) { role.appendChild(el('option', { value: o[0] }, o[1])); });
    role.value = a ? a.role : 'ADMIN';
    field(m, '角色', role);
    var scopeWrap = el('div');
    var comp = companyPicker(adminData.companies, a ? a.companyIds : []);
    field(scopeWrap, '負責公司', comp);
    var feat = el('div', { class: 'checks' });
    adminData.features.forEach(function (f) {
      var lb = el('label'); var cb = el('input', { type: 'checkbox', value: f.code });
      if (a && a.features.indexOf(f.code) >= 0) cb.checked = true;
      lb.appendChild(cb); lb.appendChild(document.createTextNode(f.label)); feat.appendChild(lb);
    });
    field(scopeWrap, '可使用的功能', feat);
    m.appendChild(scopeWrap);
    var superNote = el('div', { class: 'muted' }, '超級管理員擁有全部公司與全部功能，不需勾選。');
    m.appendChild(superNote);
    var sync = function () { var s = role.value === 'SUPER_ADMIN'; scopeWrap.classList.toggle('hidden', s); superNote.classList.toggle('hidden', !s); };
    role.onchange = sync; sync();
    return function () {
      return {
        role: role.value,
        companyIds: comp.getChecked(),
        features: Array.prototype.map.call(feat.querySelectorAll('input:checked'), function (x) { return x.value; })
      };
    };
  }

  /** 新增管理員：填寫資料 → Email 正規化與錯字提示 → 放大確認 → 寄出邀請信 */
  $('addAdminBtn').onclick = function () {
    var open = function () {
      var m = openModal('新增管理員');
      var name = field(m, '姓名', el('input', { type: 'text' }));
      var email = field(m, 'Google 帳號（Email）', el('input', { type: 'text', placeholder: 'name@gmail.com' }),
        '邀請信會寄到這個信箱；此帳號也會作為對方處理公司文件的帳號。');
      var getRole = roleFields(m, null);
      modalActions(m, '下一步', function (fail) {
        if (!name.value.trim()) return fail('請輸入姓名');
        call('checkEmail', { email: email.value }, function (r) {
          var addr = r.email;
          if (r.suggestion && confirm('您是不是要輸入「' + r.suggestion + '」？\n按「確定」採用建議，按「取消」維持原輸入。')) addr = r.suggestion;
          var input = Object.assign({ name: name.value.trim(), email: addr }, getRole());
          confirmBig('請確認邀請對象', addr, '邀請信將寄到此信箱。收到信並以 LINE 登入的人，就會成為「' + input.name + '」這位管理員，請確認信箱無誤。', '確認並寄出邀請信', function (fail2) {
            call('inviteAdmin', input, function () { closeModal(); alert('邀請信已寄出至 ' + addr + '。請通知對方於 7 天內點信中按鈕完成設定。'); loadAdmins(); },
              function (e) { fail2(e.message); });
          });
        }, function (e) { fail(e.message); });
      });
    };
    if (adminData) open(); else call('listAdmins', {}, function (d) { adminData = d; open(); });
  };

  function adminDialog(a) {
    var m = openModal('編輯管理員：' + a.name);
    var name = field(m, '姓名', el('input', { type: 'text' }));
    name.value = a.name;
    var getRole = roleFields(m, a);
    modalActions(m, '儲存', function (fail) {
      var input = Object.assign({ adminId: a.adminId, name: name.value }, getRole());
      call('updateAdmin', input, function () { closeModal(); loadAdmins(); }, function (e) { fail(e.message); });
    });
  }

  /** mode：resend＝重寄邀請（可更正 Email）；change＝既有管理員變更 Google 帳號 */
  function emailDialog(a, mode) {
    var m = openModal(a.name + (mode === 'resend' ? '：重寄邀請' : ' 的 Google 帳號'));
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, mode === 'resend'
      ? '可更正 Email 後重寄；舊的邀請連結會失效。'
      : '此帳號是這位管理員處理公司文件時使用的 Google 帳號。系統會寄確認信，本人點信中按鈕並以 LINE 登入確認後才會生效。'));
    var input = field(m, 'Google 帳號（Email）', el('input', { type: 'text', placeholder: 'name@gmail.com' }));
    if (a.emailVerification && a.emailVerification.status === 'PENDING') input.value = a.emailVerification.email;
    modalActions(m, '下一步', function (fail) {
      call('checkEmail', { email: input.value }, function (r) {
        var addr = r.email;
        if (r.suggestion && confirm('您是不是要輸入「' + r.suggestion + '」？\n按「確定」採用建議，按「取消」維持原輸入。')) addr = r.suggestion;
        var action = mode === 'resend' ? 'resendInvite' : 'setAdminEmail';
        confirmBig('請確認 Google 帳號', addr, '此 Google 帳號將取得「' + a.name + '」負責公司的雲端硬碟權限，請確認無誤。', mode === 'resend' ? '確認並重寄邀請' : '確認並寄出確認信', function (fail2) {
          call(action, { adminId: a.adminId, email: addr }, function () { closeModal(); alert('信件已寄出至 ' + addr + '。'); loadAdmins(); },
            function (e) { fail2(e.message); });
        });
      }, function (e) { fail(e.message); });
    });
  }

  function confirmBig(title, big, text, okText, onOk) {
    var m = openModal(title);
    m.appendChild(el('div', { class: 'big' }, big));
    m.appendChild(el('p', {}, text));
    modalActions(m, okText, onOk);
  }

  function toggleAdmin(a) {
    var to = a.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    var text = to === 'SUSPENDED'
      ? '停用後「' + a.name + '」將無法登入後台；其雲端硬碟權限會在檔案移交完成後撤銷。確定停用？'
      : '確定重新啟用「' + a.name + '」？';
    if (!confirm(text)) return;
    call('setAdminStatus', { adminId: a.adminId, status: to }, loadAdmins);
  }

  /* ---------- 系統設定 ---------- */
  function loadUnclassified() {
    $('uncCurrent').textContent = '載入中…'; $('uncMsg').textContent = '';
    call('getUnclassifiedFolder', {}, function (d) {
      var box = $('uncCurrent'); box.innerHTML = '';
      if (!d.folderId) { box.textContent = '目前：尚未設定'; return; }
      box.appendChild(document.createTextNode('目前：' + d.folderName + '　'));
      box.appendChild(folderLink(d.folderId));
    });
  }

  $('uncBtn').onclick = function () {
    var v = $('uncInput').value.trim();
    if (!v) return;
    if (!confirm('確定將此資料夾設為待分類資料夾？系統會先檢查安全性。')) return;
    $('uncBtn').disabled = true; $('uncMsg').className = 'msg'; $('uncMsg').textContent = '檢查中…';
    call('setUnclassifiedFolder', { folder: v }, function () {
      $('uncBtn').disabled = false; $('uncInput').value = ''; $('uncMsg').className = 'msg ok'; $('uncMsg').textContent = '已設定'; loadUnclassified();
    }, function (e) { $('uncBtn').disabled = false; $('uncMsg').className = 'msg err'; $('uncMsg').textContent = e.message; });
  };

  function loadSettings() {
    $('settingsBox').textContent = '載入中…';
    call('getSettings', {}, function (items) {
      var box = $('settingsBox'); box.innerHTML = '';
      var groups = {}, order = [];
      items.filter(function (it) { return it.editable; }).forEach(function (it) {
        if (!groups[it.group]) { groups[it.group] = []; order.push(it.group); }
        groups[it.group].push(it);
      });
      order.forEach(function (g) { box.appendChild(settingsCard(g, '', groups[g], settingRow)); });
      var locked = items.filter(function (it) { return !it.editable; });
      if (locked.length) box.appendChild(settingsCard('系統自動維護（僅供檢視）', '以下項目由系統流程自動設定或為規格定案值，放在這裡方便查閱目前的值。', locked, lockedRow));
    }, function (err) { $('settingsBox').textContent = err.message; });
  }

  function settingsCard(title, note, list, rowFn) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-title' }, title));
    if (note) card.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, note));
    var table = el('table');
    var cg = el('colgroup');
    ['34%', '', '190px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); });
    table.appendChild(cg);
    var thead = el('tr'); ['項目', '目前的值', ''].forEach(function (h) { thead.appendChild(el('th', {}, h)); });
    table.appendChild(thead);
    list.forEach(function (it) { table.appendChild(rowFn(it)); });
    card.appendChild(table);
    return card;
  }

  function lockedRow(it) {
    var tr = el('tr');
    var td1 = el('td'); td1.appendChild(el('div', {}, it.desc)); td1.appendChild(el('div', { class: 'muted' }, it.key));
    var td2 = el('td');
    td2.appendChild(el('div', {}, it.value === '' || it.value === null || it.value === undefined ? '（尚未設定）' : String(it.value)));
    if (it.why) td2.appendChild(el('div', { class: 'muted' }, it.why));
    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(el('td'));
    return tr;
  }

  function settingRow(it) {
    var tr = el('tr');
    var td1 = el('td');
    td1.appendChild(el('div', {}, it.desc));
    td1.appendChild(el('div', { class: 'muted' }, it.key + (it.min !== undefined && it.min !== null ? '（' + it.min + '～' + it.max + '）' : '') + (it.isPublic ? '｜客戶頁面可見' : '')));
    var td2 = el('td');
    var input = it.type === 'json' ? el('textarea') : el('input', { type: 'text' });
    input.value = it.value === null || it.value === undefined ? '' : String(it.value);
    var defText = String(it.defaultValue === '' ? '（空白）' : it.defaultValue);
    var msg = el('div', { class: 'msg' });
    td2.appendChild(input); td2.appendChild(el('div', { class: 'muted' }, '預設：' + defText)); td2.appendChild(msg);
    var td3 = el('td', { style: 'white-space:nowrap' });
    var btn = el('button', { class: 'btn' }, '儲存');
    var reset = el('button', { class: 'btn secondary', style: 'margin-left:6px' }, '還原預設');
    var refresh = function () { reset.disabled = String(input.value) === String(it.defaultValue); };
    var done = function (r, text) { btn.disabled = false; input.value = String(r.value); refresh(); msg.textContent = text; msg.className = 'msg ok'; };
    var fail = function (err) { btn.disabled = false; refresh(); msg.textContent = err.message; msg.className = 'msg err'; };
    input.addEventListener('input', refresh);
    btn.onclick = function () {
      btn.disabled = true; msg.textContent = '儲存中…'; msg.className = 'msg';
      call('updateSetting', { key: it.key, value: input.value }, function (r) { done(r, '已儲存'); }, fail);
    };
    reset.onclick = function () {
      if (!confirm('確定將「' + it.desc + '」還原為預設值「' + defText + '」？')) return;
      btn.disabled = true; reset.disabled = true; msg.textContent = '還原中…'; msg.className = 'msg';
      call('resetSetting', { key: it.key }, function (r) { done(r, '已還原為預設值'); }, fail);
    };
    refresh();
    td3.appendChild(btn); td3.appendChild(reset);
    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
    return tr;
  }

  /* ---------- 啟動 ---------- */
  $('logoutBtn').onclick = function () {
    api('logout', {}).then(null, function () {}).then(function () { showLogin('', '您已登出。'); });
  };

  /* ---------- 選單：分組收合、開發中頁面、發票辨識入口 ---------- */
  var DEV_PAGES = {
    'dev-cit': { title: '營所稅／綜所稅', text: '營利事業所得稅與綜合所得稅的申報進度追蹤。營業稅穩定後依序開發。' },
    'dev-wht': { title: '各類所得扣繳', text: '各類所得扣繳申報的進度追蹤。營業稅穩定後依序開發。' },
    'dev-nhi': { title: '補充健保費', text: '補充保險費申報的進度追蹤。營業稅穩定後依序開發。' },
    'dev-shareholder': { title: '公司股東資訊申報', text: '依公司法第 22 條之 1 向經濟部申報的公司負責人及股東資訊。營業稅穩定後依序開發。' }
  };
  function showDevPage(title, text) {
    $('devTitle').textContent = title;
    var box = $('devBox'); box.innerHTML = '';
    var top = el('div', { style: 'margin-bottom:6px' }); top.appendChild(badge('開發中', 'warn')); box.appendChild(top);
    box.appendChild(el('div', {}, text));
  }
  /**
   * 依角色與權限隱藏整組（組內全部項目都看不到時，連組名一起隱藏）。
   * 每次進入後台的預設（業主 2026-10-09）：只展開「稅務申報」，其他組收合；沒有稅務申報的人改展開「客戶管理」。
   * 使用中可自行點組名收合／展開；切換到某一頁時，該頁所在的組會自動展開。不記住上次狀態。
   */
  function navGroupsRefresh() {
    var groups = Array.prototype.slice.call(document.querySelectorAll('nav .grp'));
    groups.forEach(function (g) {
      var any = Array.prototype.some.call(g.querySelectorAll('a[data-page]'), function (a) { return !a.classList.contains('hidden'); });
      if (!any) g.classList.add('hidden');
    });
    var visible = groups.filter(function (g) { return !g.classList.contains('hidden'); });
    var open = visible.filter(function (g) { return g.getAttribute('data-grp') === 'tax'; })[0] || visible.filter(function (g) { return g.getAttribute('data-grp') === 'customer'; })[0];
    groups.forEach(function (g) { g.classList.toggle('collapsed', g !== open); });
  }
  function navExpandFor(page) {
    var a = document.querySelector('nav a[data-page="' + page + '"]');
    var g = a && a.closest('.grp');
    if (g) g.classList.remove('collapsed');
  }
  document.querySelectorAll('nav .grp .sec').forEach(function (sec) {
    var toggle = function () { sec.parentNode.classList.toggle('collapsed'); };
    sec.onclick = toggle;
    sec.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });


  /* ---------- 客戶總覽與頂端搜尋（選單改版第二步） ---------- */
  var coCache = null, coCacheAt = 0, coSel = -1, coMatches = [];
  function coLoad(cb) {
    if (coCache && Date.now() - coCacheAt < 5 * 60 * 1000) return cb(coCache);
    call('listCompanies', {}, function (d) { coCache = d.companies || []; coCacheAt = Date.now(); cb(coCache); }, function () { cb(coCache || []); });
  }
  function coRender() {
    var box = $('coSearchList'), q = ($('coSearch').value || '').trim().toLowerCase();
    box.innerHTML = '';
    if (!q) { box.classList.add('hidden'); return; }
    coLoad(function (list) {
      coMatches = list.filter(function (c) { return (c.companyId + ' ' + c.name + ' ' + (c.fullName || '')).toLowerCase().indexOf(q) >= 0; }).slice(0, 10);
      box.innerHTML = ''; coSel = coMatches.length ? 0 : -1;
      if (!coMatches.length) box.appendChild(el('div', { class: 'none' }, '找不到符合的客戶（只會列出您負責的公司）'));
      coMatches.forEach(function (c, i) {
        var it = el('div', { class: 'it' + (i === coSel ? ' sel' : ''), role: 'option' });
        it.appendChild(el('span', { class: 'id' }, c.companyId));
        it.appendChild(el('span', {}, c.name + (c.status === 'ACTIVE' ? '' : '（停用）')));
        it.onmousedown = function (e) { e.preventDefault(); coPick(c.companyId); };
        box.appendChild(it);
      });
      box.classList.remove('hidden');
    });
  }
  function coPick(id) {
    $('coSearch').value = ''; $('coSearchList').classList.add('hidden'); $('coSearch').blur();
    openOverview(id);
  }
  $('coSearch').oninput = coRender;
  $('coSearch').onfocus = function () { coLoad(function () {}); if ($('coSearch').value) coRender(); };
  $('coSearch').onblur = function () { setTimeout(function () { $('coSearchList').classList.add('hidden'); }, 150); };
  $('coSearch').onkeydown = function (e) {
    var items = $('coSearchList').querySelectorAll('.it');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      coSel = (coSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach(function (n, i) { n.classList.toggle('sel', i === coSel); });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var q = ($('coSearch').value || '').trim();
      if (coMatches[coSel]) coPick(coMatches[coSel].companyId);
      else if (/^\d{8}$/.test(q)) coPick(q);
    } else if (e.key === 'Escape') { $('coSearchList').classList.add('hidden'); }
  };

  var ovCompanyId = '';
  function openOverview(companyId) { ovCompanyId = String(companyId || ''); go('overview'); }
  function ovRow(card, k, v) { var r = el('div', { class: 'ovrow' }); r.appendChild(el('span', { class: 'k' }, k)); var vv = el('span'); if (v && v.nodeType) vv.appendChild(v); else vv.textContent = (v === null || v === undefined || v === '') ? '—' : String(v); r.appendChild(vv); card.appendChild(r); }
  function ovCard(box, title) { var c = el('div', { class: 'card' }); c.appendChild(el('div', { class: 'card-title' }, title)); box.appendChild(c); return c; }
  function ovGo(card, text, page) { var b = el('button', { class: 'linkbtn ovlink' }, text + ' →'); b.onclick = function () { go(page); }; card.appendChild(b); }
  function loadOverview() {
    var box = $('ovBox');
    if (!ovCompanyId) { $('ovTitle').textContent = '客戶總覽'; box.textContent = '請在上方搜尋框輸入統編或名稱。'; return; }
    box.textContent = '載入中…';
    call('overview.company', { companyId: ovCompanyId }, function (d) {
      var c = d.company;
      $('ovTitle').textContent = (c.shortName || c.name) + '　' + c.companyId;
      box.innerHTML = '';
      if (d.stale) box.appendChild(el('div', { class: 'alert' }, '系統同步異常，以下資料可能不是最新的。'));
      var grid = el('div', { class: 'ovgrid' }); box.appendChild(grid);

      var k1 = ovCard(grid, '基本資料');
      ovRow(k1, '公司全名', c.fullName || c.name);
      ovRow(k1, '簡稱', c.shortName || c.name);
      ovRow(k1, '狀態', badge(c.status === 'ACTIVE' ? '啟用' : '停用', c.status === 'ACTIVE' ? 'ok' : 'off'));
      ovRow(k1, '負責人員', d.responsible.length ? d.responsible.join('、') : '（尚未指派）');
      ovRow(k1, '客戶資料夾', c.folderId ? folderLink(c.folderId) : '（未設定）');
      if (d.tax && (d.tax.profile.taxNotes || d.tax.profile.bookkeepingNotes)) {
        if (d.tax.profile.taxNotes) ovRow(k1, '申報注意事項', d.tax.profile.taxNotes);
        if (d.tax.profile.bookkeepingNotes) ovRow(k1, '帳務注意事項', d.tax.profile.bookkeepingNotes);
      }

      if (d.tax) {
        var k2 = ovCard(grid, '營業稅');
        if (d.tax.profile.vatExcluded) k2.appendChild(el('div', { class: 'muted' }, '這家設為非營業稅申報客戶。'));
        if (!d.tax.periods.length) k2.appendChild(el('div', { class: 'muted' }, '尚無營業稅期別資料。'));
        d.tax.periods.forEach(function (p) {
          var v = el('span');
          v.appendChild(badge(p.stageLabel, p.stage === 'DONE' ? 'ok' : (p.applicable ? '' : 'off')));
          v.appendChild(document.createTextNode('　' + p.doneCount + '／' + p.totalSteps + (p.taxAmount !== null ? '　稅額 ' + money(p.taxAmount) : '') + (p.lastStep ? '　最後：' + p.lastStep.label + ' ' + String(p.lastStep.date || '').slice(5) : '')));
          ovRow(k2, p.label + (p.periodStatus === 'CLOSED' ? '（已結案）' : ''), v);
        });
        if (d.tax.profile.selfPay) k2.appendChild(el('div', { class: 'muted' }, '繳稅方式：自繳'));
        ovGo(k2, '到營業稅頁', 'tax');
      }

      if (d.bank) {
        var k3 = ovCard(grid, '收款');
        ovRow(k3, '待收請款單', d.bank.openBills ? d.bank.openBills + ' 張，共 ' + money(d.bank.outstanding) + ' 元' : '沒有');
        ovRow(k3, '先代墊未收回', d.bank.advancesOpen ? d.bank.advancesOpen + ' 筆，共 ' + money(d.bank.advanceOutstanding) + ' 元' : '沒有');
        d.bank.bills.slice(0, 4).forEach(function (x) {
          ovRow(k3, x.billingPeriod + ' ' + (KIND_LABEL[x.kind] || x.kind || ''), money(x.total) + '　' + x.statusLabel + (x.reportedAt && x.status === 'REPORTED' ? '（' + x.reportedAt.slice(5) + '）' : ''));
        });
        ovGo(k3, '到收款對帳', 'bank');
      }

      var k4 = ovCard(grid, '聯絡人（LINE 綁定）');
      if (!d.contacts.length) k4.appendChild(el('div', { class: 'muted' }, '尚無綁定的聯絡人。'));
      d.contacts.forEach(function (x) { ovRow(k4, x.name + (x.lineName && x.lineName !== x.name ? '（' + x.lineName + '）' : ''), badge(x.statusLabel, x.status === 'ACTIVE' ? 'ok' : (x.status === 'SUSPENDED' ? 'off' : 'warn'))); });
      if (d.pendingBindings) ovRow(k4, '待審核綁定', d.pendingBindings + ' 件');
      if (d.revokedContacts) k4.appendChild(el('div', { class: 'muted' }, '另有 ' + d.revokedContacts + ' 位已解除綁定。'));
      ovGo(k4, '到客戶聯絡人', 'customers');

      if (d.intake) {
        var k5 = ovCard(grid, '客戶上傳文件');
        if (!d.intake.length) k5.appendChild(el('div', { class: 'muted' }, '尚無上傳紀錄。'));
        var ymLabel = function (ym) { var s = String(ym || '').replace(/\D/g, ''); if (s.length === 6 && Number(s.slice(0, 4)) >= 1900) return (Number(s.slice(0, 4)) - 1911) + ' 年 ' + Number(s.slice(4)) + ' 月'; if (s.length === 5) return Number(s.slice(0, 3)) + ' 年 ' + Number(s.slice(3)) + ' 月'; return String(ym || ''); };
        d.intake.forEach(function (m) { ovRow(k5, ymLabel(m.yearMonth), m.files + ' 份（已處理 ' + m.processed + (m.review ? '、待確認 ' + m.review : '') + '）' + (m.lastReceivedAt ? '　最後 ' + fmtTime(m.lastReceivedAt) : '')); });
        ovGo(k5, '到客戶上傳文件', 'intake');
      }

      var k6 = ovCard(grid, '公司股東資訊');
      k6.appendChild(el('div', { class: 'muted' }, '「公司股東資訊申報」開發中，完成後會顯示在這裡。'));
    }, function (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'alert' }, e.message)); });
  }


  /* ---------- 首頁「今天要做什麼」（選單改版第三步）：跨模組彙整稅務申報、收款對帳、客戶管理、系統的待辦 ---------- */
  var homeTodoSeq = 0;
  var taxPending = null; // 從首頁卡片跳到營業稅頁後要做的事：{ type:'focus', label, ids } 或 { type:'notice', kind }
  function hasFeat(f) { return !!me && (me.role === 'SUPER_ADMIN' || (me.features || []).indexOf(f) >= 0); }
  function renderHomeTodo(home) {
    var box = $('homeTodo'), seq = ++homeTodoSeq;
    if (!hasFeat('TAX_CHECKLIST')) { drawHomeTodo(box, home, null); return; }
    if (!box.childNodes.length) box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:10px' }, '整理今天的待辦…'));
    call('tax.getHome', {}, function (th) { if (seq === homeTodoSeq) drawHomeTodo(box, home, th); },
      function () { if (seq === homeTodoSeq) drawHomeTodo(box, home, null); });
  }
  function todoLine(parent, text, label, fn) {
    var ln = el('div', { class: 'ln' }); ln.appendChild(document.createTextNode(text + ' '));
    if (label) { var b = el('button', { class: 'linkbtn' }, label); b.onclick = fn; ln.appendChild(b); }
    parent.appendChild(ln);
  }
  function todoCard(grid, n, label, hint, fn) {
    var c = el('button', { class: 'card', title: hint || '' });
    c.appendChild(el('div', { class: 'n' }, String(n))); c.appendChild(el('div', { class: 'l' }, label));
    if (hint) c.appendChild(el('div', { class: 'muted', style: 'font-size:12px' }, hint));
    c.onclick = fn; grid.appendChild(c);
  }
  function goTaxWith(action) { taxPending = action; go('tax'); }
  function drawHomeTodo(box, home, th) {
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'hsec' }, '今天要做什麼'));
    var cn = home.counts || {};

    if (th && th.period && th.deadlines) {
      var d = th.deadlines, bar = el('div', { class: 'card', style: 'display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:10px;padding:10px 14px' });
      bar.appendChild(el('strong', {}, '營業稅 ' + th.period.label));
      var c1 = el('span', {}, '申報期限 ' + d.deadline + '　'); c1.appendChild(el('strong', { style: d.daysToDeadline != null && d.daysToDeadline < 0 ? 'color:var(--danger)' : '' }, countdown(d.daysToDeadline))); bar.appendChild(c1);
      bar.appendChild(el('span', { class: 'muted' }, '繳稅期限 ' + d.payDeadline + '　' + countdown(d.daysToPayDeadline)));
      box.appendChild(bar);
    }

    // 異常（紅）：稅務與收款的異常、系統異常清單、備份
    var errs = el('div', { class: 'todo-box todo-err' }), nErr = 0;
    errs.appendChild(el('div', { class: 'ttl' }, '異常'));
    ((th && th.anomalies) || []).forEach(function (x) { if (!x.items.length) return; nErr++; todoLine(errs, (x.severity === 'high' ? '嚴重｜' : '') + x.label + '：' + x.items.length + ' ' + (x.unit || '家'), '到營業稅頁', function () { goTaxWith(null); }); });
    if (cn.exceptions && hasFeat('EXCEPTION_HANDLING')) { nErr++; todoLine(errs, '異常清單（LINE 文件、雲端權限）：' + cn.exceptions + ' 件', '到異常處理', function () { go('exceptions'); }); }
    var bk = home.backup;
    if (bk && bk.enabled && bk.lastFailed) { nErr++; todoLine(errs, '系統備份失敗', '到備份', function () { go('backup'); }); }
    var rn = home.runner;
    if (rn && rn.stopped && rn.lastHeartbeatAt) { nErr++; todoLine(errs, '背景處理已停止（可能是今日額度用完）', '', null); }
    if (nErr) box.appendChild(errs);

    // 新動態（藍）
    var nw = (th && th.news) || { moreInvoices: [], afterFiled: [], excluded: [] };
    var newsParts = [];
    if (nw.moreInvoices.length) newsParts.push('客戶又傳了發票 ' + nw.moreInvoices.length + ' 家');
    if (nw.afterFiled.length) newsParts.push('申報後又收到檔案 ' + nw.afterFiled.length + ' 家');
    if (nw.excluded.length) newsParts.push('非營業稅申報客戶有新動態 ' + nw.excluded.length + ' 家');
    if (newsParts.length) { var nb = el('div', { class: 'todo-box todo-news' }); nb.appendChild(el('div', { class: 'ttl' }, '新動態')); todoLine(nb, newsParts.join('、'), '到營業稅頁查看', function () { goTaxWith(null); }); box.appendChild(nb); }

    // 我的備忘（黃）
    if (th && th.memos) {
      var open = th.memos.filter(function (m) { return !m.done; });
      if (open.length) {
        var mb = el('div', { class: 'todo-box todo-memo' });
        var dueN = open.filter(function (m) { return m.dueDate && m.dueDate <= th.today; }).length;
        mb.appendChild(el('div', { class: 'ttl' }, '我的備忘（' + open.length + ' 則待辦' + (dueN ? '，' + dueN + ' 則已到期' : '') + '）'));
        open.slice(0, 3).forEach(function (m) { var late = m.dueDate && m.dueDate <= th.today; mb.appendChild(el('div', { class: 'ln', style: late ? 'font-weight:700;color:var(--danger)' : '' }, '・' + m.text + (m.dueDate ? '（' + m.dueDate.slice(5) + '）' : ''))); });
        todoLine(mb, open.length > 3 ? '還有 ' + (open.length - 3) + ' 則' : '', '管理備忘', function () { scrollToMemo = true; goTaxWith(null); });
        box.appendChild(mb);
      }
    }

    // 待辦卡片：依模組分組，只列有數字的
    var any = false;
    function group(title, items) {
      items = items.filter(function (x) { return x.n; });
      if (!items.length) return;
      any = true;
      box.appendChild(el('div', { class: 'todo-grp' }, title));
      var grid = el('div', { class: 'todo-cards' });
      items.forEach(function (x) { todoCard(grid, x.n, x.label, x.hint, x.fn); });
      box.appendChild(grid);
    }
    if (th && th.cards) {
      var taxCards = th.cards.filter(function (c) { return c.key !== 'reconDiff' && c.key !== 'reportedLate'; });
      group('營業稅', taxCards.map(function (c) {
        return { n: c.count, label: c.label, hint: c.hint, fn: function () { goTaxWith(CARD_NOTICE[c.key] ? { type: 'notice', kind: CARD_NOTICE[c.key] } : { type: 'focus', label: c.label, ids: c.filingIds }); } };
      }));
      var bankCards = th.cards.filter(function (c) { return c.key === 'reconDiff' || c.key === 'reportedLate'; });
      group('收款對帳', bankCards.map(function (c) { return { n: c.count, label: c.label, hint: c.hint, fn: function () { openLedger('ALL', c.key === 'reconDiff' ? 'diff' : 'reportedLate'); } }; }));
    }
    var custItems = [];
    if (home.pendingBindings && hasFeat('BINDING_APPROVAL')) custItems.push({ n: home.pendingBindings, label: '待審核綁定', hint: '客戶送出的綁定申請', fn: function () { go('bindings'); } });
    if (cn.unclassified && cn.unclassified.files) custItems.push({ n: cn.unclassified.customers, label: '未分類文件的客戶', hint: cn.unclassified.files + ' 份，最久等待 ' + cn.unclassified.oldestDays + ' 天', fn: function () { go('unclassified'); } });
    var ik = home.intake;
    if (ik && ik.enabled && ik.months) custItems.push({ n: ik.months, label: '待處理上傳文件', hint: ik.files + ' 份' + (ik.review ? '，' + ik.review + ' 份需人工確認' : ''), fn: function () { go('intake'); } });
    group('客戶管理', custItems);
    if (bk && bk.enabled && bk.ackOverdue) group('系統', [{ n: bk.daysSinceAck, label: '天沒下載備份到地端', hint: '每月下載一次備份 ZIP', fn: function () { go('backup'); } }]);

    if (!any && !nErr && !newsParts.length) box.appendChild(el('div', { class: 'card muted', style: 'padding:12px 14px' }, '目前沒有待辦事項。'));
  }

  function closeMenu() { $('nav').classList.remove('open'); $('navMask').classList.remove('open'); }
  $('menuBtn').onclick = function () { $('nav').classList.add('open'); $('navMask').classList.add('open'); };
  $('navMask').onclick = closeMenu;
  document.querySelectorAll('nav a[data-page]').forEach(function (a) { a.onclick = function () { closeMenu(); go(a.getAttribute('data-page')); }; });
  $('statPending').onclick = function () { go('bindings'); };
  $('statUnc').onclick = function () { go('unclassified'); };
  $('statExc').onclick = function () { go('exceptions'); };
  $('statIntake').onclick = function () { go('intake'); };
  $('statBackup').onclick = function () { go('backup'); };
  $('overlay').onclick = function (e) { if (e.target === $('overlay')) closeModal(); };

  function enter(notice) {
    showBusy('載入中…');
    call('getHome', {}, function (home) { hideBusy(); showApp(home); if (notice) alert(notice); },
      function (err) { hideBusy(); showLogin(err.message, notice); });
  }

  /* ---------- 稅務申報（營業稅）：資料與規則都在 Cloudflare（閘道直接回答，沒有 Apps Script 備援） ---------- */
  var STEP_LABELS = { NOTICE1: '通知1', NOTICE2: '通知2', INVOICE_RECEIVED: '發票回傳', BILL_ISSUED: '出請款單', BILL_NOTIFIED: '通知請款', PAID_REPORTED: '回報匯款', RECONCILED: '對帳', TAX_PAID: '繳稅', FILED: '申報' };
  var taxData = null, taxSel = {}, taxBusy = false, taxView = 'B';
  try { if (localStorage.getItem('taxView') === 'A') taxView = 'A'; } catch (e) { /* 沒有瀏覽器儲存也能用 */ }
  var TAX_FILTERS = [['', '全部']].concat(Object.keys(STEP_LABELS).map(function (c) { return [c, '未做：' + STEP_LABELS[c]]; })).concat([['NOTES', '有備註或注意事項'], ['NA', '不適用']]);

  function todayStr() { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function stepDone(row, code) { return !!(row.steps[code] && row.steps[code].status === 'DONE'); }
  function lastStep(row, order) { var last = ''; order.forEach(function (c) { if (stepDone(row, c)) last = c; }); return last; }
  function taxRow(id) { return (taxData && taxData.rows || []).filter(function (r) { return r.filingId === id; })[0]; }

  function loadTax(periodId) {
    $('taxBox').textContent = '載入中…';
    taxAFocus = null;
    loadTaxHome(periodId);
    call('tax.getBoard', { taxType: 'VAT', periodId: periodId || undefined }, function (d) {
      taxData = d; taxSel = {}; renderTax();
      var pa = taxPending; taxPending = null;
      if (pa && pa.type === 'notice' && taxData.period) noticeDialog(pa.kind);
      if (pa && pa.type === 'focus' && pa.ids && pa.ids.length) { taxAFocus = { label: pa.label, ids: pa.ids }; taxView = 'A'; try { localStorage.setItem('taxView', 'A'); } catch (e) { /* 略過 */ } renderTaxTable(); $('taxBox').scrollIntoView(); }
    },
      function (err) { $('taxBox').textContent = err.message; });
  }

  function renderTax() {
    var d = taxData, bar = $('taxPeriodBar'); bar.innerHTML = '';
    var stale = $('taxStale'); stale.classList.toggle('hidden', !d.stale); stale.textContent = d.stale ? ('唯讀模式：' + d.staleMessage) : '';
    var sel = el('select', { style: 'width:auto' });
    d.periods.forEach(function (p) { var o = el('option', { value: p.periodId }, p.label + (p.status === 'CLOSED' ? '（已結案）' : '')); if (d.period && p.periodId === d.period.periodId) o.selected = true; sel.appendChild(o); });
    sel.onchange = function () { loadTax(sel.value); };
    if (d.periods.length) bar.appendChild(sel);
    if (d.period) {
      bar.appendChild(el('span', {}, '申報期限：' + d.period.deadline));
      bar.appendChild(el('span', { class: 'muted' }, '繳稅期限：' + d.period.payDeadline));
      if (d.period.weekendWarning) {
        var ww = d.period.weekendWarning;
        bar.appendChild(el('span', { class: 'badge', style: 'background:#fff4e5;color:#9a5b00' }, '申報期限是週' + ww.weekday + '，建議順延到 ' + ww.suggested));
        if (d.caps.isSuper && d.period.status === 'OPEN') {
          var bw = el('button', { class: 'btn small secondary' }, '套用建議日期');
          bw.onclick = function () { if (confirm('把申報期限改為 ' + ww.suggested + '（繳稅期限會跟著變）？')) call('tax.setDeadline', { periodId: d.period.periodId, deadline: ww.suggested }, function () { loadTax(d.period.periodId); }); };
          bar.appendChild(bw);
        }
      }
      bar.appendChild(badge(d.period.status === 'OPEN' ? '進行中' : '已結案', d.period.status === 'OPEN' ? 'ok' : 'off'));
    } else bar.appendChild(el('span', { class: 'muted' }, '尚未開啟任何期別。'));
    if (d.caps.isSuper) {
      var b1 = el('button', { class: 'btn small' }, '開啟新期別'); b1.onclick = openPeriodDialog; bar.appendChild(b1);
      if (d.period) {
        var b2 = el('button', { class: 'btn small secondary' }, d.period.status === 'OPEN' ? '結案' : '重新開啟');
        b2.onclick = function () {
          if (!confirm(d.period.status === 'OPEN' ? '結案後此期別只能查看，確定結案？' : '確定重新開啟此期別？')) return;
          call('tax.setPeriodStatus', { periodId: d.period.periodId, status: d.period.status === 'OPEN' ? 'CLOSED' : 'OPEN' }, function () { loadTax(d.period.periodId); });
        };
        var b3 = el('button', { class: 'btn small secondary' }, '修改期限'); b3.onclick = deadlineDialog;
        bar.appendChild(b2); bar.appendChild(b3);
      }
    }
    var b4 = el('button', { class: 'btn small secondary' }, '客戶資料'); b4.onclick = profilesDialog; bar.appendChild(b4);
    var bu = el('button', { class: 'btn small' }, '上傳請款單'); bu.onclick = function () { go('taxup'); }; bar.appendChild(bu);
    if (d.caps.isSuper) { var bs = el('button', { class: 'btn small secondary' }, '模組設定'); bs.onclick = function () { go('taxsettings'); }; bar.appendChild(bs); }
    var b5 = el('button', { class: 'btn small secondary' }, '重新整理'); b5.onclick = function () { loadTax(d.period && d.period.periodId); }; bar.appendChild(b5);
    // 文件目錄索引立即更新：把檔案拖進客戶資料夾後不想等 5 分鐘時按（一次涵蓋全部公司，不是整家重掃；申報書約 1 分鐘內讀取）
    var b6 = el('button', { class: 'btn small secondary', title: '把檔案拖進雲端硬碟資料夾後，不想等 5 分鐘時按：立刻更新文件目錄，並讀取新的申報書與繳稅回執' }, '立即更新文件');
    b6.onclick = function () {
      b6.disabled = true; var old = b6.textContent; b6.textContent = '更新中…';
      call('indexRefreshNow', {}, function (r) { b6.disabled = false; b6.textContent = old; alert(r.message || '已更新'); if (r.ran) loadTax(d.period && d.period.periodId); },
        function (e) { b6.disabled = false; b6.textContent = old; alert(e.message); });
    };
    bar.appendChild(b6);
    var ss = $('taxStepSel'); ss.innerHTML = ''; d.steps.forEach(function (c) { ss.appendChild(el('option', { value: c }, STEP_LABELS[c])); });
    var nb = $('taxNotice'); nb.innerHTML = ''; nb.classList.add('hidden');
    function note(text, label, fn) {
      nb.classList.remove('hidden');
      var line = el('div'); line.appendChild(el('span', {}, text + ' '));
      if (label) { var lb = el('button', { class: 'linkbtn' }, label); lb.onclick = fn; line.appendChild(lb); }
      nb.appendChild(line);
    }
    var idx = d.period ? d.periods.map(function (x) { return x.periodId; }).indexOf(d.period.periodId) : -1;
    if (idx > 0) note('這是歷史期別（' + d.period.label + '），仍可修改。', '回到最新期別', function () { loadTax(d.periods[0].periodId); });
    else if (idx === 0 && d.earlierUnfiled > 0 && d.periods.length > 1) note('上一期尚有 ' + d.earlierUnfiled + ' 家未申報。', '查看上一期', function () { loadTax(d.periods[1].periodId); });
    if (d.missingCount > 0 && d.caps.canWrite) note('有 ' + d.missingCount + ' 家客戶還沒加入本期（新客戶或剛加回的客戶）。', '全部加入', function () {
      call('tax.syncFilings', { periodId: d.period.periodId }, function () { loadTax(d.period.periodId); }, function (e) { alert(e.message); });
    });
    renderTaxTable();
  }

  function taxVisibleRows() {
    var d = taxData, q = ($('taxSearch').value || '').trim().toLowerCase(), f = $('taxFilter').value;
    return d.rows.filter(function (r) {
      if (q && (r.companyId + ' ' + r.shortName + ' ' + r.companyName).toLowerCase().indexOf(q) < 0) return false;
      if (f === 'NA') return !r.applicable;
      if (!r.applicable) return false;
      if (f === 'NOTES') return !!(r.note || r.taxNotes || r.bookkeepingNotes);
      if (f) return !stepDone(r, f);
      return true;
    });
  }

  /** A 待辦追蹤：依「下一步該做什麼」分組；回報匯款只當說明文字，不單獨成組 */
  /** 目前階段（M1 4.2，與閘道 rules.js currentStage 相同）：由後往前看已完成的階段，不要求照順序 */
  function stageOf(r) {
    var o = r.steps || {}, done = function (c) { return !!(o[c] && o[c].status === 'DONE'); };
    if (done('FILED')) return 'DONE';
    if (done('TAX_PAID')) return 'FILE';
    if (r.paymentMethod === 'SELF_PAY' && done('BILL_ISSUED')) return 'AWAIT_CUSTOMER_TAX';
    if (done('RECONCILED')) return r.taxAmount === 0 ? 'FILE' : 'PAY_TAX';
    if (done('PAID_REPORTED')) return 'RECON';
    if (done('BILL_NOTIFIED')) return 'AWAIT_PAY';
    if (done('BILL_ISSUED')) return 'BILL_NOTIFY';
    if (done('INVOICE_RECEIVED')) return 'CALC';
    if (done('NOTICE1') || done('NOTICE2')) return 'AWAIT_INVOICE';
    return 'NOTICE1_DUE';
  }
  var STAGE_ORDER = ['NOTICE1_DUE', 'AWAIT_INVOICE', 'CALC', 'BILL_NOTIFY', 'AWAIT_PAY', 'RECON', 'PAY_TAX', 'AWAIT_CUSTOMER_TAX', 'FILE', 'DONE'];
  var STAGE_NAMES = { NOTICE1_DUE: '該發第一次通知', AWAIT_INVOICE: '尚未回傳發票', CALC: '待計算稅額', BILL_NOTIFY: '待通知請款', AWAIT_PAY: '等客戶匯款', RECON: '待對帳', PAY_TAX: '待繳稅', AWAIT_CUSTOMER_TAX: '待客戶繳稅', FILE: '待申報', DONE: '完成' };
  var STAGE_NEXT_STEP = { NOTICE1_DUE: 'NOTICE1', AWAIT_INVOICE: 'INVOICE_RECEIVED', CALC: 'BILL_ISSUED', BILL_NOTIFY: 'BILL_NOTIFIED', AWAIT_PAY: 'PAID_REPORTED', RECON: 'RECONCILED', PAY_TAX: 'TAX_PAID', AWAIT_CUSTOMER_TAX: 'TAX_PAID', FILE: 'FILED' };
  var taxAFocus = null; // { label, ids }：由首頁卡片帶入，只顯示這些列

  function renderTaxA(rows, box) {
    var d = taxData, canMark = d.period.status === 'OPEN' && d.caps.canWrite;
    if (taxAFocus) {
      var chip = el('div', { class: 'alert', style: 'display:flex;justify-content:space-between;align-items:center' });
      chip.appendChild(el('span', {}, '篩選：' + taxAFocus.label + '（' + taxAFocus.ids.length + ' 家）'));
      var cb = el('button', { class: 'btn small secondary' }, '清除篩選'); cb.onclick = function () { taxAFocus = null; renderTaxTable(); }; chip.appendChild(cb);
      box.appendChild(chip);
      var set = {}; taxAFocus.ids.forEach(function (id) { set[id] = 1; });
      rows = rows.filter(function (r) { return set[r.filingId]; });
    }
    var by = {}; STAGE_ORDER.forEach(function (c) { by[c] = []; });
    rows.forEach(function (r) { if (r.applicable) by[stageOf(r)].push(r); });
    STAGE_ORDER.forEach(function (code) {
      var list = by[code];
      if (taxAFocus && !list.length) return;
      var card = el('div', { class: 'card', style: 'margin-bottom:10px' });
      card.appendChild(el('div', { class: 'card-title' }, STAGE_NAMES[code] + '（' + list.length + '）'));
      if (!list.length) card.appendChild(el('div', { class: 'muted' }, '沒有。'));
      list.forEach(function (r) {
        var line = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-top:1px solid var(--line)' });
        var left = el('div'), nm = el('button', { class: 'linkbtn', style: 'text-decoration:none;color:inherit' }, (r.shortName || r.companyName) + '　' + r.companyId);
        nm.onclick = function () { notesDialog(r); }; left.appendChild(nm);
        var last = lastStep(r, d.steps), info = [];
        if (last) info.push('最近完成：' + STEP_LABELS[last] + ' ' + r.steps[last].date.slice(5));
        if (stepDone(r, 'PAID_REPORTED') && !stepDone(r, 'RECONCILED')) info.push('客戶已回報匯款 ' + r.steps.PAID_REPORTED.date.slice(5));
        if (r.invoices && r.invoices.newCount > 0) info.push('又收到 ' + r.invoices.newCount + ' 份（最近 ' + r.invoices.newLastAt.slice(5, 10) + '）');
        if (r.reports && r.reports.INVOICES_DONE) info.push('✓客戶已確認傳完發票 ' + r.reports.INVOICES_DONE.slice(5));
        if (r.reports && r.reports.NO_INVOICE) info.push('客戶回覆本期沒有發票 ' + r.reports.NO_INVOICE.slice(5));
        docLines(r).forEach(function (t) { info.push(t); });
        if (r.advance && (r.advance.status === 'OPEN' || r.advance.status === 'PARTIAL')) info.push('先代墊 ' + money(r.advance.remaining) + ' 元未收回');
        left.appendChild(el('div', { class: 'muted', style: 'font-size:12px' }, info.join('　·　')));
        line.appendChild(left);
        var next = STAGE_NEXT_STEP[code];
        if (next) {
          var mb = el('button', { class: 'btn small secondary' }, '標記：' + STEP_LABELS[next]); mb.disabled = !canMark || taxBusy;
          mb.onclick = function () { taxMark([r.filingId], next, 'DONE', todayStr()); }; line.appendChild(mb);
        }
        card.appendChild(line);
      });
      box.appendChild(card);
    });
  }

  /** 非營業稅申報客戶：資料保留，隨時可加回 */
  function renderExcluded() {
    var d = taxData, box = $('taxExcluded'); box.innerHTML = '';
    if (!d.excluded || !d.excluded.length) return;
    var det = el('details', { class: 'card', style: 'margin-top:10px' });
    det.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600' }, '非營業稅申報客戶（' + d.excluded.length + ' 家）'));
    d.excluded.forEach(function (e) {
      var line = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-top:1px solid var(--line);margin-top:6px' });
      line.appendChild(el('span', {}, (e.shortName || e.companyName) + '　' + e.companyId));
      var b = el('button', { class: 'btn small secondary' }, '加回營業稅申報客戶'); b.disabled = !d.caps.canWrite;
      b.onclick = function () {
        call('tax.setVatExcluded', { companyIds: [e.companyId], excluded: false }, function () { loadTax(d.period && d.period.periodId); }, function (er) { alert(er.message); });
      };
      line.appendChild(b); det.appendChild(line);
    });
    box.appendChild(det);
  }


  /* ---------- 發送清單（P5 第一步，M1 9.4）：四種通知共用；第一步只有手動路徑（複製訊息 → 貼到客戶 LINE → 標記已手動傳送） ---------- */
  var NOTICE_TABS = [['NOTICE1', '第一次通知'], ['NOTICE2', '第二次通知'], ['BILL', '請款通知'], ['DUN', '催款']];
  var CARD_NOTICE = { due1: 'NOTICE1', due2: 'NOTICE2', billNotify: 'BILL', dun: 'DUN' };

  function copyText(text, done) {
    function fallback() {
      var ta = el('textarea', { style: 'position:fixed;left:-1000px;top:0' }); ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove(); done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }

  function noticeDialog(kind, due) {
    var m = openModal('發送通知'); $('modal').style.width = 'min(1040px,96vw)';
    var box = el('div', { class: 'muted' }, '載入中…'); m.appendChild(box);
    var periodId = taxData && taxData.period ? taxData.period.periodId : undefined;
    call('tax.getNoticeList', { kind: kind, periodId: periodId, paymentDeadline: due }, function (d) { box.remove(); renderNotice(m, d); }, function (e) { box.textContent = e.message; });
  }

  function renderNotice(m, d) {
    var ticked = {}, rowOf = {};
    d.todo.concat(d.sent).forEach(function (r) { rowOf[r.filingId] = r; });
    d.todo.forEach(function (r) { if (r.ticked) ticked[r.filingId] = 1; });
    // 一家公司有多張請款單時，每張各有勾選（一起勾＝合併成一則；只勾一張＝只發那一張）
    var billSel = {};
    d.todo.concat(d.sent).forEach(function (r) { if (r.bills && r.bills.length > 1) { var o = {}; r.defaultBills.forEach(function (id) { o[id] = 1; }); billSel[r.filingId] = o; } });
    function selIds(r) { var o = billSel[r.filingId]; return o ? r.bills.filter(function (b) { return o[b.billId]; }).map(function (b) { return b.billId; }) : null; }
    function msgOf(r) { var ids = selIds(r); if (ids && r.messages && ids.length) { var k = ids.slice().sort().join('+'); if (r.messages[k]) return r.messages[k]; } return { message: r.message, lineMessage: r.lineMessage, amount: r.amount }; }
    function noBillPicked() { return Object.keys(ticked).some(function (id) { var x = selIds(rowOf[id]); return x && !x.length; }); }
    function billIdsOf(id) { var x = selIds(rowOf[id]); return x ? { billIds: x } : {}; }

    var tabs = el('div', { class: 'toolbar' });
    NOTICE_TABS.forEach(function (t) {
      var b = el('button', { class: 'btn small' + (t[0] === d.kind ? '' : ' secondary') }, t[1]);
      b.onclick = function () { noticeDialog(t[0]); }; tabs.appendChild(b);
    });
    m.appendChild(tabs);
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, d.period.label + '｜客戶還沒綁定 LINE 時走手動：按「複製訊息」→ 貼到客戶的 LINE 傳送 → 回來按「標記已手動傳送」才會記錄。'));
    if (d.stale) m.appendChild(el('div', { class: 'alert' }, '唯讀模式：' + d.staleMessage));
    if (!d.sendEnabled) m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, 'LINE 自動發送尚未開啟（超級管理員在「模組設定」頁開啟後，已綁定 LINE 的客戶可直接發送）。'));
    var needPoll = d.todo.concat(d.sent).some(function (r) { return r.queue && (r.queue.status === 'QUEUED' || r.queue.status === 'SENDING'); });
    if (needPoll && !(window.__noticePoll)) {
      window.__noticePoll = 1;
      setTimeout(function () { window.__noticePoll = 0; if ($('overlay').classList.contains('hidden')) return; if ($('modal').innerText.indexOf('發送通知') !== 0) return; noticeDialog(d.kind, d.kind === 'BILL' ? d.paymentDeadline : undefined); }, 6000);
    }

    var dueInput = null;
    if (d.kind === 'BILL') {
      var bar = el('div', { class: 'toolbar' });
      bar.appendChild(el('span', {}, '本批付款期限：'));
      dueInput = el('input', { type: 'date', style: 'width:auto' }); dueInput.value = d.paymentDeadline || '';
      dueInput.onchange = function () { noticeDialog('BILL', dueInput.value || ''); };
      bar.appendChild(dueInput);
      bar.appendChild(el('span', { class: 'muted' }, d.defaultPaymentDeadline ? '（預設＝申報期限前一天，可改；改了訊息會跟著更新）' : (d.paymentDeadline ? '（已超過申報期限，沒有預設；這是您填的日期，改了訊息會跟著更新）' : '（已超過申報期限，沒有預設，請自行填寫）')));
      m.appendChild(bar);
      if (d.needPaymentDeadline) m.appendChild(el('div', { class: 'alert' }, '請先填付款期限，訊息才會完整。'));
    }

    var count = el('span', { class: 'muted' });
    // 每家這次的收件人（預設＝綁定帳號扣掉排除清單，可在列上調整）與「不合併」旗標
    var recState = {};
    d.todo.concat(d.sent).forEach(function (r) { var sel = {}; r.boundList.forEach(function (u) { sel[u.userId] = u.selected; }); recState[r.filingId] = { sel: sel, nm: {} }; });
    function recOf(r) { var st = recState[r.filingId]; return r.boundList.filter(function (u) { return st.sel[u.userId]; }).map(function (u) { return { u: u.userId, name: u.name, m: st.nm[u.userId] ? 0 : 1 }; }); }
    function lineIds() { return Object.keys(ticked).filter(function (id) { var r = rowOf[id]; var sb = selIds(r); return !(sb && !sb.length) && recOf(r).length > 0 && !(r.queue && (r.queue.status === 'QUEUED' || r.queue.status === 'SENDING')); }); }
    /** 合併摘要：同一位收件人名下勾選了多家 → 合併為一則（每 12 家一則）；回傳 { people, messages, lines } */
    function mergePlan() {
      var per = {}, singles = 0, people = 0;
      lineIds().forEach(function (id) { recOf(rowOf[id]).forEach(function (x) { people++; if (x.m) (per[x.u] = per[x.u] || { name: x.name, n: 0 }).n++; else singles++; }); });
      var messages = singles, lines = [];
      Object.keys(per).forEach(function (u) { var k = per[u].n; messages += Math.ceil(k / 12); if (k > 1) lines.push(per[u].name + '：' + k + ' 家合併為 ' + Math.ceil(k / 12) + ' 則'); });
      return { people: people, messages: messages, lines: lines };
    }
    function updateCount() {
      var n = Object.keys(ticked).length, ln = lineIds().length;
      count.textContent = '已勾選 ' + n + ' 家（可 LINE 發送 ' + ln + ' 家）';
      var mp = mergePlan(); mergeBox.textContent = mp.lines.length ? ('合併發送：' + mp.lines.join('；') + '（LINE 約用 ' + mp.messages + ' 則）') : '';
      var nb = noBillPicked();
      mark.disabled = !n || !d.canWrite || nb; sendBtn.disabled = !ln || !d.canWrite || !d.sendEnabled || nb;
      mark.title = nb ? '有公司沒有勾選任何一張請款單' : '';
    }
    var mergeBox = el('div', { class: 'muted', style: 'margin:4px 0;color:#1f4f99' });
    var mark = el('button', { class: 'btn secondary' }, '標記已手動傳送');
    var sendBtn = el('button', { class: 'btn' }, '發送所選（LINE）'); sendBtn.title = d.sendEnabled ? '' : 'LINE 自動發送尚未開啟（超級管理員在模組設定頁開啟）';

    function rowLine(r, parent, isSent) {
      var line = el('div', { style: 'border-top:1px solid var(--line);padding:6px 0' });
      var top = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' });
      var tip = el('span', { class: 'muted', style: 'font-size:12px' });
      var cb = el('input', { type: 'checkbox' }); cb.checked = !!ticked[r.filingId]; cb.disabled = !d.canWrite;
      cb.onchange = function () { if (cb.checked) ticked[r.filingId] = 1; else delete ticked[r.filingId]; updateCount(); };
      var info = [];
      var amtSpan = el('span', {});
      function paintAmt() { var a = msgOf(r).amount; amtSpan.textContent = (a != null ? '合計 ' + String(a).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '') + (isSent && r.sentAt ? '　已發 ' + r.sentAt.slice(5) : ''); }
      paintAmt();
      top.appendChild(cb); top.appendChild(el('strong', { style: 'min-width:90px' }, r.name)); top.appendChild(el('span', { class: 'muted' }, r.companyId));
      top.appendChild(amtSpan);
      if (r.amountChanged) top.appendChild(el('span', { class: 'badge warn' }, '金額已變動：原 ' + r.amountChanged.from + '→' + r.amountChanged.to));
      if (r.anomaly) top.appendChild(el('span', { class: 'badge err' }, r.anomaly));
      var who = el('span', { class: 'badge off' });
      function paintWho() {
        var rl = recOf(r);
        who.className = 'badge ' + (rl.length ? 'ok' : 'off');
        who.textContent = !r.boundList.length ? '未綁定' : (rl.length ? '將發給：' + rl.map(function (x) { return x.name + (x.m ? '' : '（不合併）'); }).join('、') : '無收訊對象');
        who.title = !r.boundList.length ? '還沒有綁定 LINE，請用複製訊息' : '可按「調整」改這一批的收件人';
      }
      paintWho(); top.appendChild(who);
      var panel = null;
      if (r.boundList.length) {
        var adj = el('button', { class: 'linkbtn' }, '調整收件人');
        adj.onclick = function () {
          if (panel) { panel.remove(); panel = null; return; }
          panel = el('div', { style: 'margin:6px 0 0 26px;padding:8px;border:1px dashed #a9b7c9;border-radius:6px;font-size:13px' });
          panel.appendChild(el('div', { class: 'muted', style: 'margin-bottom:4px' }, '這一批要發給誰（取消勾選＝不發）；「不合併」＝這位的訊息不跟他名下其他公司合併成一則：'));
          var st = recState[r.filingId], boxes = [];
          r.boundList.forEach(function (u) {
            var ln = el('div', { style: 'padding:2px 0' });
            var c1 = el('input', { type: 'checkbox' }); c1.checked = !!st.sel[u.userId];
            var c2 = el('input', { type: 'checkbox', style: 'margin-left:14px' }); c2.checked = !!st.nm[u.userId];
            ln.appendChild(c1); ln.appendChild(el('span', { style: 'margin:0 4px' }, u.name)); ln.appendChild(c2); ln.appendChild(el('span', { class: 'muted', style: 'margin-left:4px' }, '不合併'));
            panel.appendChild(ln); boxes.push([u, c1, c2]);
          });
          var rem = el('input', { type: 'checkbox' }), reml = el('label', { style: 'display:flex;gap:6px;align-items:center;margin-top:6px' });
          reml.appendChild(rem); reml.appendChild(el('span', {}, '以後「' + (d.kind === 'NOTICE1' || d.kind === 'NOTICE2' ? '發票資料' : '請款付款') + '」類訊息都這樣發（只記錄誰收；合併設定只針對這一批）'));
          panel.appendChild(reml);
          var ok = el('button', { class: 'btn small', style: 'margin-top:6px' }, '套用');
          ok.onclick = function () {
            boxes.forEach(function (b) { st.sel[b[0].userId] = b[1].checked; st.nm[b[0].userId] = b[2].checked; });
            paintWho(); updateCount();
            if (rem.checked) {
              var excluded = boxes.filter(function (b) { return !b[1].checked; }).map(function (b) { return b[0].userId; });
              call('tax.saveRecipients', { companyId: r.companyId, classKey: (d.kind === 'NOTICE1' || d.kind === 'NOTICE2') ? 'INVOICE' : 'BILL', excludedUserIds: excluded }, function () { tip.textContent = '已記住這家的收件人設定'; }, function (e) { alert(e.message); });
            }
            panel.remove(); panel = null;
          };
          panel.appendChild(ok); line.appendChild(panel);
        };
        top.appendChild(adj);
      }
      if (r.queue) {
        var QS = { QUEUED: '排隊中', SENDING: '發送中', SENT: '已送出', FAILED: '失敗' };
        top.appendChild(el('span', { class: 'badge ' + (r.queue.status === 'FAILED' ? 'err' : (r.queue.status === 'SENT' ? 'ok' : 'warn')), title: r.queue.error || '' }, (QS[r.queue.status] || r.queue.status) + (r.queue.status === 'FAILED' && r.queue.error ? '：' + r.queue.error.slice(0, 40) : '') + (r.queue.status === 'QUEUED' && r.queue.attempts > 0 ? '（第 ' + r.queue.attempts + ' 次失敗，稍後重試）' : '')));
      }
      var sp = el('span', { style: 'flex:1' }); top.appendChild(sp);
      var pv = el('button', { class: 'linkbtn' }, '預覽'), cp = el('button', { class: 'btn small secondary' }, '複製訊息');
      var msg = el('div', { style: 'display:none;white-space:pre-wrap;background:#f6f8fb;border-radius:6px;padding:8px;margin:6px 0 0 26px;font-size:13px' });
      function paintMsg() { var mo = msgOf(r); msg.textContent = r.boundList.length ? ('【LINE 版（下方會有按鈕）】' + String.fromCharCode(10) + mo.lineMessage + String.fromCharCode(10) + String.fromCharCode(10) + '【手動複製版】' + String.fromCharCode(10) + mo.message) : mo.message; paintAmt(); }
      paintMsg();
      pv.onclick = function () { msg.style.display = msg.style.display === 'none' ? 'block' : 'none'; };
      cp.onclick = function () {
        copyText(msgOf(r).message, function (ok) {
          tip.textContent = ok ? '已複製，貼到客戶 LINE 傳送後再按下方「標記已手動傳送」' : '複製失敗，請按「預覽」手動選取文字';
          if (ok && d.canWrite) { ticked[r.filingId] = 1; cb.checked = true; updateCount(); } // 複製後預選；沒按「標記」不會記錄
        });
      };
      top.appendChild(pv); top.appendChild(cp); top.appendChild(tip);
      line.appendChild(top);
      if (r.bills && r.bills.length > 1) {
        var bb = el('div', { style: 'margin:4px 0 0 26px;font-size:13px;padding:6px 8px;background:#fbf8ef;border-radius:6px' });
        bb.appendChild(el('div', { class: 'muted', style: 'margin-bottom:2px' }, '這家有 ' + r.bills.length + ' 張請款單：一起勾＝合併成一則訊息（一顆「我已匯款」按鈕代表全部）；只勾一張＝只發那一張，另一張之後再發會是獨立一則。'));
        r.bills.forEach(function (b) {
          var ln = el('label', { style: 'display:block;padding:1px 0' }), c = el('input', { type: 'checkbox' });
          c.checked = !!billSel[r.filingId][b.billId]; c.disabled = !d.canWrite;
          c.onchange = function () { if (c.checked) billSel[r.filingId][b.billId] = 1; else delete billSel[r.filingId][b.billId]; paintMsg(); updateCount(); };
          ln.appendChild(c);
          ln.appendChild(document.createTextNode(' ' + b.kindLabel + '　' + String(b.amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 元（' + b.items.map(function (i) { return i.label; }).join('、') + '）'));
          if (b.sentAt && !b.todo) ln.appendChild(el('span', { class: 'muted' }, '　已發 ' + b.sentAt.slice(5)));
          else if (b.changed) ln.appendChild(el('span', { class: 'badge warn' }, '金額已變動'));
          bb.appendChild(ln);
        });
        line.appendChild(bb);
      }
      line.appendChild(msg); parent.appendChild(line);
    }

    var cardTodo = el('div', { class: 'card', style: 'margin-bottom:8px' });
    cardTodo.appendChild(el('div', { class: 'card-title' }, d.label + '：該發的 ' + d.todo.length + ' 家'));
    if (!d.todo.length) cardTodo.appendChild(el('div', { class: 'muted' }, '目前沒有該發的客戶。'));
    d.todo.forEach(function (r) { rowLine(r, cardTodo, false); });
    m.appendChild(cardTodo);
    if (d.sent.length) {
      var det = el('details', { class: 'card', style: 'margin-bottom:8px' });
      det.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600' }, '已發過（' + d.sent.length + ' 家）— 需要重發時再勾選'));
      d.sent.forEach(function (r) { rowLine(r, det, true); });
      m.appendChild(det);
    }

    var foot = el('div', { class: 'actions', style: 'align-items:center' });
    var msgBox = el('span', { class: 'muted' });
    var close = el('button', { class: 'btn secondary' }, '關閉'); close.onclick = function () { closeModal(); };
    mark.onclick = function () {
      var ids = Object.keys(ticked);
      if (!ids.length) return;
      if (d.kind === 'BILL' && !(dueInput && dueInput.value)) return alert('請先填寫本批付款期限。');
      mark.disabled = true; msgBox.textContent = '處理中…';
      call('tax.markNotified', {
        kind: d.kind, paymentDeadline: dueInput ? dueInput.value : undefined,
        items: ids.map(function (id) { return Object.assign({ filingId: id, updatedAt: rowOf[id].updatedAt }, billIdsOf(id)); })
      }, function (res) {
        var bad = res.results.filter(function (x) { return !x.ok; });
        if (bad.length) alert(bad.length + ' 家沒有完成：' + bad[0].message + '\n（其餘已記錄；畫面會重新載入）');
        if (taxData && taxData.period) loadTax(taxData.period.periodId);
        noticeDialog(d.kind, dueInput ? dueInput.value : undefined);
      }, function (e) { mark.disabled = false; msgBox.textContent = ''; alert(e.message); });
    };
    sendBtn.onclick = function () {
      var ids = lineIds();
      if (!ids.length) return;
      if (d.kind === 'BILL' && !(dueInput && dueInput.value)) return alert('請先填寫本批付款期限。');
      var mp = mergePlan(), people = mp.people, msgs = mp.messages;
      sendBtn.disabled = true; msgBox.textContent = '查詢本月 LINE 用量…';
      call('tax.noticeUsage', {}, function (u) {
        var usage = u && u.ok ? ('本月已用 ' + u.used + ' 則' + (u.limit != null ? '／上限 ' + u.limit + ' 則' : '（無上限）')) : '暫時查不到本月用量';
        var short = u && u.ok && u.limit != null && u.used + msgs > u.limit;
        msgBox.textContent = '';
        if (!confirm('即將用 LINE 發送「' + d.label + '」給 ' + ids.length + ' 家公司（共 ' + people + ' 位收件人' + (mp.lines.length ? '，合併後約使用 ' + msgs + ' 則：' + mp.lines.join('；') : '，約使用 ' + msgs + ' 則') + '）。\n' + usage + (short ? '\n\n警告：加上這一批會超過本月上限！' : '') + '\n\n確定發送？')) { updateCount(); return; }
        msgBox.textContent = '送出中…';
        call('tax.sendNotices', {
          kind: d.kind, paymentDeadline: dueInput ? dueInput.value : undefined,
          items: ids.map(function (id) { return Object.assign({ filingId: id, updatedAt: rowOf[id].updatedAt, recipients: recOf(rowOf[id]).map(function (x) { return { u: x.u, m: x.m }; }) }, billIdsOf(id)); })
        }, function (res) {
          var bad = res.results.filter(function (x) { return !x.ok; });
          if (bad.length) alert(bad.length + ' 家沒有排入發送：' + bad[0].message);
          if (res.queued) call('tax.noticeKick', {}, function () {}, function () {}); // 啟動發送（失敗也沒關係，每分鐘會自動輪詢）
          noticeDialog(d.kind, dueInput ? dueInput.value : undefined);
        }, function (e) { msgBox.textContent = ''; updateCount(); alert(e.message); });
      }, function () { msgBox.textContent = ''; updateCount(); alert('查詢 LINE 用量失敗，請稍後再試。'); });
    };
    updateCount();
    foot.appendChild(count); foot.appendChild(msgBox); foot.appendChild(close); foot.appendChild(mark); foot.appendChild(sendBtn);
    m.appendChild(mergeBox); m.appendChild(foot);
  }
  $('taxNoticeBtn').onclick = function () { if (!taxData || !taxData.period) return alert('請先開啟期別。'); noticeDialog('NOTICE1'); };

  /* ---------- 收款對帳表（M2 第 4 步）：一列一張請款單；登記收款（現金／其他）、差額處理 ---------- */
  var lg = null;   // { data, filter, q, open: { billId: true } }
  var DIFF_LABEL = { WAIVED: '免收', NEXT_PERIOD_OFFSET: '下期抵扣', REFUND: '退款', CUSTOMER_TOPUP: '等客戶補匯' };
  var KIND_LABEL = { GENERAL: '一般', PREPAY: '暫繳', CIT: '營所稅', PIT: '綜所稅', UNDIST: '未分配盈餘稅' };
  var METHOD_LABEL = { BANK: '銀行入帳', CASH: '現金', OTHER: '其他' };
  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function remaining(r) { return r.total - r.received - r.fee; }

  /** 差額＝應收 − 實收（匯費也算在內）＋旁邊的性質標籤；還沒收任何款的不顯示（避免整欄都是數字） */
  function diffInfo(r) {
    if (r.received + r.fee <= 0) return null;
    var diff = r.total - r.received;
    if (diff === 0) return null;
    var tag = '', cls = '', title = '';
    if (r.status === 'RECONCILED' && r.fee === diff) { tag = '匯費免收'; cls = 'ok'; title = '待收 ' + money(r.total) + ' − 入帳 ' + money(r.received) + ' ＝ 匯費 ' + diff + ' 元（在匯費容許內，視為匯費免收）'; }
    else if (r.status === 'RESOLVED') { tag = DIFF_LABEL[r.diffResolution] || '已處理'; cls = 'ok'; title = r.diffNote || ''; }
    else if (r.diffResolution === 'CUSTOMER_TOPUP') { tag = '等客戶補匯'; cls = 'warn'; title = r.diffNote || ''; }
    else if (r.status === 'PARTIAL') { tag = '部分收款'; cls = 'warn'; if (r.fee) title = '其中匯費免收 ' + r.fee + ' 元'; }
    else if (r.status === 'DIFF') { tag = diff < 0 ? '多收' : '有差額'; cls = 'err'; }
    return { diff: diff, tag: tag, cls: cls, title: title };
  }

  /** 一列的狀態文字與標籤（逾期、客戶回報超過 N 天仍未對上） */
  function ledgerStatus(r, d) {
    var s = { text: '', cls: '', extra: [] }, rem = remaining(r);
    if (r.status === 'RECONCILED') { s.text = '已對帳'; s.cls = 'ok'; }
    else if (r.status === 'RESOLVED') { s.text = '已處理'; s.cls = 'ok'; }
    else if (r.status === 'PARTIAL') { s.text = '部分收款'; s.cls = 'warn'; }
    else if (r.status === 'DIFF') { s.text = rem < 0 ? '多收' : '有差額'; s.cls = 'err'; }
    else if (r.status === 'REPORTED') { s.text = '客戶已回報'; s.cls = 'warn'; }
    else { s.text = '未收'; s.cls = 'off'; }
    var open = r.status === 'UNPAID' || r.status === 'REPORTED' || r.status === 'PARTIAL';
    if (open && r.dueDate && d.today > r.dueDate) s.extra.push(['逾期 ' + dayDiff(r.dueDate, d.today) + ' 天', 'err']);
    if (r.status === 'REPORTED' && r.reportedAt && dayDiff(r.reportedAt, d.today) > d.warnDays) s.extra.push(['客戶回報 ' + dayDiff(r.reportedAt, d.today) + ' 天仍未對到入帳', 'warn']);
    return s;
  }
  function ledgerMatchFilter(r, f, d) {
    var st = r.status, open = st === 'UNPAID' || st === 'REPORTED' || st === 'PARTIAL';
    if (f === 'unpaid') return st === 'UNPAID';
    if (f === 'reported') return st === 'REPORTED';
    if (f === 'partial') return st === 'PARTIAL';
    if (f === 'reportedLate') return st === 'REPORTED' && !!r.reportedAt && dayDiff(r.reportedAt, d.today) > d.warnDays;   // 客戶回報超過 N 天仍對不到入帳
    if (f === 'diff') return (st === 'PARTIAL' || st === 'DIFF') && !r.diffResolution; // 待處理的差額（不含匯費免收與已處理）
    if (f === 'overdue') return open && !!r.dueDate && d.today > r.dueDate;
    if (f === 'done') return st === 'RECONCILED' || st === 'RESOLVED';
    return true;
  }

  var ledgerPreset = null;   // { period, filter }：從首頁卡片點進來時指定帳期（ALL＝全部帳期）與篩選
  function openLedger(period, filter) { ledgerPreset = { period: period, filter: filter }; bankTab = 'ledger'; go('bank'); }
  function loadLedger(period) {
    var box = $('bankLedgerView'), pre = ledgerPreset; ledgerPreset = null;
    if (pre) period = pre.period;
    if (!lg) box.textContent = '載入中…';
    call('bank.getLedger', { period: period || (lg && lg.data ? lg.data.period : undefined) }, function (d) {
      lg = { data: d, filter: pre ? pre.filter : (lg ? lg.filter : 'all'), q: pre ? '' : (lg ? lg.q : ''), open: pre ? {} : (lg ? lg.open : {}) };
      renderLedger();
    }, function (e) { box.textContent = e.message; });
  }

  function renderLedger() {
    var d = lg.data, box = $('bankLedgerView'); box.innerHTML = '';
    var bar = el('div', { class: 'toolbar' });
    var per = el('select', { style: 'width:auto' });
    d.periods.forEach(function (p) { per.appendChild(el('option', { value: p }, '帳期 ' + p)); });
    per.appendChild(el('option', { value: 'ALL' }, '全部帳期'));
    per.value = d.period; per.onchange = function () { lg.open = {}; loadLedger(per.value); };
    var fil = el('select', { style: 'width:auto' });
    [['all', '全部'], ['unpaid', '未匯款'], ['reported', '客戶已回報未對帳'], ['reportedLate', '客戶回報逾期'], ['partial', '部分收款'], ['diff', '有待處理的差額'], ['overdue', '逾期'], ['done', '已對帳']].forEach(function (o) { fil.appendChild(el('option', { value: o[0] }, o[1])); });
    fil.value = lg.filter; fil.onchange = function () { lg.filter = fil.value; paint(); };
    var q = el('input', { type: 'text', placeholder: '搜尋統編、簡稱' }); q.value = lg.q; q.oninput = function () { lg.q = q.value; paint(); };
    var rf = el('button', { class: 'btn small secondary' }, '重新整理'); rf.onclick = function () { loadLedger(d.period); };
    bar.appendChild(per); bar.appendChild(fil); bar.appendChild(q); bar.appendChild(rf); box.appendChild(bar);
    if (!d.canWrite) box.appendChild(el('div', { class: 'alert' }, '唯讀模式：系統同步異常，暫時無法登記或修改。'));
    box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' }, '一列是一張請款單（同一家公司同一帳期有營業稅單與暫繳單時各一列）。差額＝應收 − 實收（匯費也算在內），**點差額的數字**可以處理；點「展開」可看已確認的收款、登記現金、合併其他客戶。金額單位：元。'));
    var tbl = el('div'); box.appendChild(tbl);
    function paint() {
      tbl.innerHTML = '';
      var key = lg.q.trim().toLowerCase();
      var list = d.rows.filter(function (r) { return ledgerMatchFilter(r, lg.filter, d) && (!key || (r.companyId + ' ' + r.name).toLowerCase().indexOf(key) >= 0); });
      if (!list.length) { tbl.appendChild(el('div', { class: 'muted' }, d.rows.length ? '沒有符合的請款單。' : '這個帳期還沒有請款單。')); return; }
      var isAll = d.period === 'ALL', t = el('table', { class: 'ledger' }), h = el('tr');
      if (isAll) h.appendChild(el('th', {}, '帳期'));
      ['統編', '簡稱', '類別', '記帳費', '稅金', '其他', '應收', '付款期限', '客戶回報', '實收', '入帳日', '差額', '狀態', ''].forEach(function (x, i) { h.appendChild(el('th', [3, 4, 5, 6, 9, 11].indexOf(i) >= 0 ? { class: 'num' } : {}, x)); }); t.appendChild(h);
      var tot = { total: 0, received: 0, diff: 0 };
      list.forEach(function (r) {
        var st = ledgerStatus(r, d), info = diffInfo(r), tr = el('tr');
        if (isAll) tr.appendChild(el('td', {}, r.billingPeriod));
        tot.total += r.total; tot.received += r.received; if (info) tot.diff += info.diff;
        [r.companyId, r.name, KIND_LABEL[r.kind] || r.kind, money(r.bookkeeping), money(r.tax), money(r.other), money(r.total), r.dueDate ? r.dueDate.slice(5) : '', r.reportedAt ? r.reportedAt.slice(5) : '', money(r.received), r.receivedAt ? r.receivedAt.slice(5) : ''].forEach(function (x, i) {
          tr.appendChild(el('td', i >= 3 && i <= 6 || i === 9 ? { class: 'num' } : {}, x));
        });
        var dtd = el('td', { class: 'num' });
        if (info) {
          var db = el('button', { class: 'linkbtn' }, (info.diff < 0 ? '−' : '') + money(Math.abs(info.diff))); db.title = '點一下處理或查看這個差額'; db.onclick = function () { diffDialog(r, d); };
          dtd.appendChild(db);
          if (info.tag) { var tg = badge(info.tag, info.cls); if (info.title) tg.title = info.title; tg.style.marginLeft = '6px'; dtd.appendChild(tg); }
        }
        tr.appendChild(dtd);
        var sd = el('td'); sd.appendChild(badge(st.text, st.cls)); st.extra.forEach(function (x) { sd.appendChild(badge(x[0], x[1])); }); tr.appendChild(sd);
        var op = el('td'), ex = el('button', { class: 'linkbtn' }, lg.open[r.billId] ? '收合' : '展開');
        ex.onclick = function () { lg.open[r.billId] = !lg.open[r.billId]; paint(); };
        op.appendChild(ex); tr.appendChild(op); t.appendChild(tr);
        if (lg.open[r.billId]) {
          var dr = el('tr'), dt = el('td', { colspan: String(14 + (isAll ? 1 : 0)), style: 'background:#f6f8fb' });
          dt.appendChild(ledgerDetail(r, d)); dr.appendChild(dt); t.appendChild(dr);
        }
      });
      var fr = el('tr', { style: 'font-weight:600' });
      fr.appendChild(el('td', { colspan: String(6 + (isAll ? 1 : 0)) }, '合計（' + list.length + ' 張）'));
      fr.appendChild(el('td', { class: 'num' }, money(tot.total))); fr.appendChild(el('td', { colspan: '2' }, ''));
      fr.appendChild(el('td', { class: 'num' }, money(tot.received))); fr.appendChild(el('td', {}, ''));
      fr.appendChild(el('td', { class: 'num' }, tot.diff ? (tot.diff < 0 ? '−' : '') + money(Math.abs(tot.diff)) : '')); fr.appendChild(el('td', { colspan: '2' }, ''));
      t.appendChild(fr);
      var sc = el('div', { class: 'scrollx' }); sc.appendChild(t); tbl.appendChild(sc);
    }
    paint();
  }

  /** 點差額數字：匯費免收（自動處理）→ 看明細；已處理 → 看處理結果並可撤銷或重選；其餘 → 處理視窗 */
  function diffDialog(r, d) {
    var info = diffInfo(r), rem = remaining(r);
    if (r.diffResolution && r.status !== 'RECONCILED') {
      var m = openModal('差額已處理');
      m.appendChild(el('div', { class: 'muted' }, r.companyId + ' ' + r.name + '　應收 ' + money(r.total) + '，已收 ' + money(r.received + r.fee)));
      m.appendChild(el('p', {}, '處理方式：' + (DIFF_LABEL[r.diffResolution] || r.diffResolution)));
      m.appendChild(el('p', {}, '備註：' + (r.diffNote || '（無）') + (r.resolvedBy ? '（' + (String(r.resolvedBy).indexOf('ADVANCE:') === 0 ? '系統：代墊已收回' : r.resolvedBy) + ' ' + (r.resolvedAt || '').slice(0, 10) + '）' : '')));
      var acts = el('div', { class: 'actions' }), close = el('button', { class: 'btn secondary' }, '關閉'); close.onclick = closeModal;
      var re = el('button', { class: 'btn secondary' }, '重新選擇處理方式'); re.disabled = !d.canWrite || rem === 0; re.onclick = function () { closeModal(); resolveDialog(r, d); };
      var ro = el('button', { class: 'btn' }, '撤銷處理'); ro.disabled = !d.canWrite;
      ro.onclick = function () { if (!confirm('撤銷後，這張請款單回到依實收金額計算的狀態。確定？')) return; ro.disabled = true; call('bank.resolveDiff', { billId: r.billId, resolution: 'REOPEN' }, function () { closeModal(); loadLedger(d.period); }, function (e) { ro.disabled = false; alert(e.message); }); };
      acts.appendChild(close); acts.appendChild(re); acts.appendChild(ro); m.appendChild(acts);
      return;
    }
    if (r.status === 'RECONCILED') {
      var m2 = openModal('差額明細');
      m2.appendChild(el('div', { class: 'muted' }, r.companyId + ' ' + r.name + '　' + (KIND_LABEL[r.kind] || '') + '請款單'));
      m2.appendChild(el('p', {}, '應收 ' + money(r.total) + '，實收 ' + money(r.received) + '，差 ' + money(info ? info.diff : 0) + ' 元。'));
      m2.appendChild(el('p', {}, '這個差額在匯費容許內，系統已視為「匯費免收」，這張請款單已對帳完成，不需要處理。'));
      var a2 = el('div', { class: 'actions' }), c2 = el('button', { class: 'btn secondary' }, '關閉'); c2.onclick = closeModal; a2.appendChild(c2); m2.appendChild(a2);
      return;
    }
    resolveDialog(r, d);
  }

  function ledgerDetail(r, d) {
    var box = el('div', { style: 'padding:6px 4px' });
    box.appendChild(el('div', { style: 'font-weight:600;margin-bottom:4px' }, '已確認的收款'));
    if (!r.matches.length) box.appendChild(el('div', { class: 'muted' }, '還沒有已確認的收款。'));
    else {
      var t = el('table', { class: 'auto' }), h = el('tr'); ['入帳日', '方式', '金額', '匯費', '規則', '確認人', '備註', ''].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      r.matches.forEach(function (m) {
        var tr = el('tr');
        [m.date, METHOD_LABEL[m.method] || m.method, money(m.amount), m.fee ? String(m.fee) : '', RULE_LABEL[m.rule] || (m.rule === 'CASH' ? '手動登記' : m.rule), m.by, m.note || ''].forEach(function (x) { tr.appendChild(el('td', {}, x)); });
        var td = el('td');
        if (m.canCancel) {
          var c = el('button', { class: 'linkbtn' }, '取消'); c.disabled = !d.canWrite;
          c.onclick = function () {
            if (!confirm('取消這筆' + (METHOD_LABEL[m.method] || '') + '收款 ' + money(m.amount) + ' 元？請款單會回到取消前的狀態。')) return;
            call('bank.cancelMatch', { matchId: m.matchId }, function () { loadLedger(d.period); });
          };
          td.appendChild(c);
        } else td.appendChild(el('span', { class: 'muted' }, '需銀行對帳權限'));
        tr.appendChild(td); t.appendChild(tr);
      });
      box.appendChild(t);
    }
    var acts = el('div', { style: 'margin-top:8px' }), rem = remaining(r);
    var closed = r.status === 'RECONCILED' || r.status === 'RESOLVED';
    var reg = el('button', { class: 'btn small' }, '登記收款（現金／其他）'); reg.disabled = !d.canWrite || closed; reg.style.marginRight = '10px';
    reg.onclick = function () { registerDialog(r, d); }; acts.appendChild(reg);
    var mg = el('button', { class: 'btn small secondary' }, '合併其他客戶'); mg.disabled = !d.canWrite; mg.style.marginRight = '10px'; mg.title = '一筆款同時付了好幾家客戶時，在這裡把款項分給／併入其他客戶'; mg.onclick = function () { mergeDialog(r, d); }; acts.appendChild(mg);
    box.appendChild(acts);
    if (r.advanceOpen > 0) {
      var av = el('div', { class: 'muted', style: 'margin-top:8px;color:#9a5b00' }, '這家客戶尚有未收回代墊 ' + money(r.advanceOpen) + ' 元（代墊不併入請款單金額）。');
      var avb = el('button', { class: 'linkbtn', style: 'margin-left:6px' }, '看代墊帳款'); avb.onclick = function () { advPreset = r.companyId; bankTab = 'advance'; showBankPage(); };
      av.appendChild(avb); box.appendChild(av);
    }
    return box;
  }

  /**
   * 合併其他客戶：從任何一張請款單按下去，選要跟哪一家合併，系統自動判斷方向——
   *   這張多收、對方還差 → 把這張多收的款分給對方；對方多收、這張還差 → 把對方多收的款併進這張。
   * 不必先分辨誰多收誰少收（例：鑫富餘多收 2,823、祝好生活店還差 2,833）。
   */
  function mergeDialog(r, d) {
    var dlg = openModal('合併其他客戶');
    var rem = remaining(r), over = r.received + r.fee - r.total, cands = [];
    var mine = r.matches.filter(function (m) { return m.canCancel; }).sort(function (a, b) { return b.amount - a.amount; })[0];
    // 這張多收 → 分給其他還差的請款單
    if (over > 0 && mine) d.openBills.forEach(function (o) {
      if (o.billId === r.billId) return;
      cands.push({ dir: 'out', other: o.name + '（' + (KIND_LABEL[o.kind] || '') + ' ' + o.billingPeriod + '）', otherRem: o.remaining, billId: o.billId, matchId: mine.matchId, movable: Math.min(over, mine.amount), amount: Math.min(over, mine.amount, o.remaining), gap: Math.abs(over - o.remaining) });
    });
    // 這張還差 → 併入同帳期其他客戶多收的款
    if (rem > 0) d.rows.forEach(function (x) {
      var xo = x.received + x.fee - x.total;
      if (x.billId === r.billId || xo <= 0) return;
      x.matches.filter(function (m) { return m.canCancel; }).forEach(function (m) {
        var mv = Math.min(xo, m.amount);
        cands.push({ dir: 'in', other: x.name + '（' + (KIND_LABEL[x.kind] || '') + ' ' + x.billingPeriod + '）', otherOver: xo, billId: r.billId, matchId: m.matchId, movable: mv, amount: Math.min(rem, mv), gap: Math.abs(xo - rem) });
      });
    });
    cands.sort(function (a, b) { return a.gap - b.gap; });
    dlg.appendChild(el('div', { class: 'muted' }, r.companyId + ' ' + r.name + '（' + (KIND_LABEL[r.kind] || '') + '請款單）　應收 ' + money(r.total) + '，已收 ' + money(r.received + r.fee) + '　→　' + (over > 0 ? '多收 ' + money(over) : (rem > 0 ? '還差 ' + money(rem) : '已收齊'))));
    dlg.appendChild(el('div', { class: 'muted', style: 'margin:4px 0 8px' }, '一筆款有時同時付了好幾家客戶的請款單。選要跟哪一家合併，系統會自動判斷：這張多收的分給對方，或把對方多收的併進這張。'));
    if (!cands.length) {
      dlg.appendChild(el('div', { class: 'alert' }, over > 0 ? '目前沒有其他還沒收齊的請款單可以分。' : (rem > 0 ? '同一帳期目前沒有其他客戶「多收」的款項可以併入。若那筆款還沒在「銀行明細」對帳，請先到銀行明細用「指定客戶」，一筆款可以同時分給多家公司。' : '這張請款單已經收齊，沒有可以合併的。')));
      var c0 = el('button', { class: 'btn secondary' }, '關閉'); c0.onclick = closeModal; var a0 = el('div', { class: 'actions' }); a0.appendChild(c0); dlg.appendChild(a0); return;
    }
    var sel = el('select');
    cands.slice(0, 80).forEach(function (c, i) {
      sel.appendChild(el('option', { value: String(i) }, (c.dir === 'out' ? '把 ' + r.name + ' 多收的分給 → ' + c.other + '　（對方還差 ' + money(c.otherRem) + '）' : '把 ← ' + c.other + ' 多收的併進 ' + r.name + '　（對方多收 ' + money(c.otherOver) + '）')));
    });
    var amount = el('input', { type: 'number', min: '1' });
    function paintAmt() { amount.value = cands[Number(sel.value)].amount; }
    sel.onchange = paintAmt; paintAmt();
    var tag = el('input', { type: 'text', placeholder: '例如：鑫富餘祝好生活店（選填）' });
    field(dlg, '跟哪一家合併', sel); field(dlg, '合併金額', amount); field(dlg, '把這個匯款標註也加到分得款項的公司（下次自動認得，選填）', tag);
    var msg = el('div', { class: 'msg err' }), acts = el('div', { class: 'actions' });
    var cancel = el('button', { class: 'btn secondary' }, '取消'), ok = el('button', { class: 'btn' }, '合併');
    cancel.onclick = closeModal;
    ok.onclick = function () {
      msg.textContent = '';
      var c = cands[Number(sel.value)], a = Math.round(Number(amount.value) || 0);
      if (a <= 0 || a > c.movable) { msg.textContent = '合併金額要大於 0，且不超過可移動的 ' + money(c.movable) + '。'; return; }
      ok.disabled = true;
      call('bank.reassignMatch', { matchId: c.matchId, moves: [{ billId: c.billId, amount: a }], learn: tag.value.trim() ? { tag: tag.value.trim(), accounts: [], names: [] } : undefined }, function () { closeModal(); loadLedger(d.period); }, function (e) { ok.disabled = false; msg.textContent = e.message; });
    };
    acts.appendChild(cancel); acts.appendChild(ok); dlg.appendChild(msg); dlg.appendChild(acts);
  }

  function registerDialog(r, d) {
    var m = openModal('登記收款（不經銀行的收款）');
    m.appendChild(el('div', { class: 'muted' }, r.companyId + ' ' + r.name + '　' + (KIND_LABEL[r.kind] || '') + '請款單　應收 ' + money(r.total) + '，已收 ' + money(r.received + r.fee) + '，待收 ' + money(remaining(r))));
    var method = el('select'); [['CASH', '現金'], ['OTHER', '其他方式']].forEach(function (o) { method.appendChild(el('option', { value: o[0] }, o[1])); });
    var amount = el('input', { type: 'number', min: '1' }); amount.value = remaining(r) > 0 ? remaining(r) : '';
    var date = el('input', { type: 'date' }); date.value = d.today;
    var note = el('input', { type: 'text', placeholder: '例如：客戶來公司付現金尾款' });
    field(m, '收款方式', method); field(m, '金額', amount); field(m, '收款日期', date); field(m, '備註', note);
    var msg = el('div', { class: 'msg err' }), acts = el('div', { class: 'actions' });
    var cancel = el('button', { class: 'btn secondary' }, '取消'), ok = el('button', { class: 'btn' }, '登記');
    cancel.onclick = closeModal;
    ok.onclick = function () {
      msg.textContent = '';
      var a = Math.round(Number(amount.value) || 0);
      if (a <= 0) { msg.textContent = '請填金額。'; return; }
      if (a > remaining(r) && !confirm('金額 ' + money(a) + ' 超過待收 ' + money(remaining(r)) + '，會變成多收（差額）。確定登記？')) return;
      ok.disabled = true;
      call('bank.registerPayment', { billId: r.billId, method: method.value, amount: a, date: date.value, note: note.value }, function () { closeModal(); loadLedger(d.period); }, function (e) { ok.disabled = false; msg.textContent = e.message; });
    };
    acts.appendChild(cancel); acts.appendChild(ok); m.appendChild(msg); m.appendChild(acts);
  }

  function resolveDialog(r, d) {
    var rem = remaining(r), under = rem > 0;
    var m = openModal('處理差額');
    m.appendChild(el('div', { class: 'muted' }, r.companyId + ' ' + r.name + '　應收 ' + money(r.total) + '，已收 ' + money(r.received + r.fee) + '　→　' + (under ? '還差 ' + money(rem) : '多收 ' + money(-rem))));
    var sel = el('select'), opts = under ? [['WAIVED', '免收（這個差額不收了）'], ['NEXT_PERIOD_OFFSET', '下期抵扣（併入下期請款）'], ['CUSTOMER_TOPUP', '等客戶補匯（維持部分收款，補匯後再對）']] : [['REFUND', '退款給客戶'], ['NEXT_PERIOD_OFFSET', '下期抵扣'], ['WAIVED', '免收（多收的不退、不抵）']];
    opts.forEach(function (o) { sel.appendChild(el('option', { value: o[0] }, o[1])); });
    var note = el('input', { type: 'text', placeholder: '備註（必填）' });
    field(m, '處理方式', sel); field(m, '備註', note);
    if (!under) {
      var tr2 = el('button', { class: 'btn small secondary', style: 'margin-top:6px' }, '多收的其實是其他客戶的？合併其他客戶…');
      tr2.onclick = function () { closeModal(); mergeDialog(r, d); };
      m.appendChild(tr2);
    }
    var msg = el('div', { class: 'msg err' }), acts = el('div', { class: 'actions' });
    var cancel = el('button', { class: 'btn secondary' }, '取消'), ok = el('button', { class: 'btn' }, '確定');
    cancel.onclick = closeModal;
    ok.onclick = function () {
      msg.textContent = '';
      if (note.value.trim().length < 2) { msg.textContent = '請填處理備註。'; return; }
      ok.disabled = true;
      call('bank.resolveDiff', { billId: r.billId, resolution: sel.value, note: note.value }, function () { closeModal(); loadLedger(d.period); }, function (e) { ok.disabled = false; msg.textContent = e.message; });
    };
    acts.appendChild(cancel); acts.appendChild(ok); m.appendChild(msg); m.appendChild(acts);
  }

  /* ---------- 收款對帳：銀行明細（M2 第 3 步）。交易只在這個頁面的記憶體，不上傳、不存雲端；只有「按送出確認結果」才把對帳結果寫入 ---------- */
  var bs = null;   // 本次選檔的工作階段：{ fileName, txns, rows, ctx, tab, info }
  var RULE_LABEL = { A: '金額相符', B: '差匯費', C: '分次加總', D: '一筆多張', E: '只憑金額', F: '金額不符（部分收款或差額）', MANUAL: '手動指定', TAX_REF: '銷帳編號＋稅額' };
  var BANK_TABS = [['exact', '完全相符'], ['propose', '建議'], ['unmatched', '未對上'], ['tax', '代繳稅款'], ['othertax', '其他代繳稅款'], ['done', '已處理／非客戶']];
  /** 預設只處理檔案最後一筆往前 60 天（業主 2026-10-09 決定）；日期用 2026-10-08 格式 */
  function defaultFrom(latest) { var d = new Date(latest.replace(/\//g, '-') + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 60); return d.toISOString().slice(0, 10); }
  function inScopeTx(tx) { return tx.dt.slice(0, 10).replace(/\//g, '-') >= bs.from.replace(/\//g, '-'); }
  function dateRange() { return { from: bs.from.replace(/-/g, '/'), to: bs.maxDate }; }
  function reloadCtx(then) { call('bank.getContext', dateRange(), function (ctx) { bs.ctx = ctx; bs.ctxAt = new Date(); buildRows(); renderStmt(); if (then) then(); }, function (e) { renderStmt(); alert('重新取得比對資料失敗：' + e.message + '\n請重新整理頁面。'); }); }
  function money(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function sha256Hex(text) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(hex); }
  function dateMs(dt) { return Date.parse(dt.slice(0, 10).replace(/\//g, '-') + 'T00:00:00'); }

  /* ---------- 代墊帳款（M2 第 5 步 5A，規格八之一）：在稅務申報頁公司視窗「標記先代墊」後建立；客戶層級的應收，不併入請款單金額 ---------- */
  var ADV_STATUS = { OPEN: ['未收回', 'warn'], PARTIAL: ['部分收回', 'warn'], RECOVERED: ['已收回', 'ok'], WRITTEN_OFF: ['已沖銷', 'off'] };
  var ADV_TAX = { VAT: '營業稅', PREPAY: '暫繳' };
  var advState = null, advPreset = '';   // advState: { data, status, q, open }；advPreset：從客戶帳款表跳來時預填的搜尋字

  function loadAdvances(status) {
    var box = $('bankAdvanceView');
    if (!advState) box.textContent = '載入中…';
    var st = status || (advState ? advState.status : 'OPEN');
    call('bank.getAdvances', { status: st }, function (d) {
      advState = { data: d, status: st, q: advPreset || (advState ? advState.q : ''), open: advState ? advState.open : {} };
      advPreset = '';
      renderAdvances();
    }, function (e) { box.textContent = e.message; });
  }

  function renderAdvances() {
    var d = advState.data, box = $('bankAdvanceView'); box.innerHTML = '';
    var bar = el('div', { class: 'toolbar' });
    var fil = el('select', { style: 'width:auto' });
    [['OPEN', '未收回與部分收回'], ['RECOVERED', '已收回'], ['WRITTEN_OFF', '已沖銷'], ['ALL', '全部']].forEach(function (o) { fil.appendChild(el('option', { value: o[0] }, o[1])); });
    fil.value = advState.status; fil.onchange = function () { loadAdvances(fil.value); };
    var q = el('input', { type: 'text', placeholder: '搜尋統編、簡稱' }); q.value = advState.q; q.oninput = function () { advState.q = q.value; paint(); };
    var rf = el('button', { class: 'btn small secondary' }, '重新整理'); rf.onclick = function () { loadAdvances(advState.status); };
    bar.appendChild(fil); bar.appendChild(q); bar.appendChild(rf); box.appendChild(bar);
    if (!d.canWrite) box.appendChild(el('div', { class: 'alert' }, '唯讀模式：系統同步異常，暫時無法沖銷或取消標記。'));
    box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' }, '代墊由您手動決定：到「稅務申報」點公司簡稱 → 標記先代墊。代墊帳款是客戶層級的應收，不併入請款單金額。已代墊超過 ' + d.overdueDays + ' 天仍未收回會標「逾期」（天數由超級管理員在稅務模組設定修改）。金額單位：元。'));
    var tbl = el('div'); box.appendChild(tbl);
    function paint() {
      tbl.innerHTML = '';
      var key = advState.q.trim().toLowerCase();
      var list = d.rows.filter(function (a) { return !key || (a.companyId + ' ' + a.name).toLowerCase().indexOf(key) >= 0; });
      if (!list.length) { tbl.appendChild(el('div', { class: 'muted' }, d.rows.length ? '沒有符合的代墊。' : (advState.status === 'OPEN' ? '目前沒有未收回的代墊。' : '沒有資料。'))); return; }
      var t = el('table', { class: 'ledger' }), h = el('tr');
      ['統編', '簡稱', '帳期', '稅別', '代墊金額', '代墊日', '已幾天', '已收回', '還剩', '狀態', ''].forEach(function (x, i) { h.appendChild(el('th', [4, 6, 7, 8].indexOf(i) >= 0 ? { class: 'num' } : {}, x)); }); t.appendChild(h);
      var tot = { amount: 0, recovered: 0, remaining: 0 };
      list.forEach(function (a) {
        var tr = el('tr'), s = ADV_STATUS[a.status] || [a.status, 'off'];
        tot.amount += a.amount; tot.recovered += a.recovered; tot.remaining += a.remaining;
        [a.companyId, a.name, a.periodLabel || '', ADV_TAX[a.taxType] || a.taxType, money(a.amount), a.advancedAt ? a.advancedAt.slice(5) : '', a.status === 'OPEN' || a.status === 'PARTIAL' ? String(a.days) : '', a.recovered ? money(a.recovered) : '', a.remaining ? money(a.remaining) : ''].forEach(function (x, i) {
          tr.appendChild(el('td', [4, 6, 7, 8].indexOf(i) >= 0 ? { class: 'num' } : {}, x));
        });
        var sd = el('td'); sd.appendChild(badge(s[0], s[1])); if (a.overdue) { var ob = badge('逾期', 'err'), why = []; if (a.overdueReasons && a.overdueReasons.days) why.push('已代墊超過 ' + d.overdueDays + ' 天仍未收回'); if (a.overdueReasons && a.overdueReasons.nextBill) why.push('下期請款單（' + a.overdueReasons.nextBill + ' 帳期）已匯入，但沒有補收這筆代墊'); ob.title = why.join('；'); sd.appendChild(ob); } tr.appendChild(sd);
        var op = el('td'), ex = el('button', { class: 'linkbtn' }, advState.open[a.advanceId] ? '收合' : '展開');
        ex.onclick = function () { advState.open[a.advanceId] = !advState.open[a.advanceId]; paint(); };
        op.appendChild(ex);
        if (a.canWriteOff) { var wo = el('button', { class: 'linkbtn', style: 'margin-left:8px' }, '沖銷'); wo.disabled = !d.canWrite; wo.onclick = function () { writeOffDialog(a); }; op.appendChild(wo); }
        if (a.canCancel) { var cn = el('button', { class: 'linkbtn', style: 'margin-left:8px' }, '取消標記'); cn.disabled = !d.canWrite; cn.title = '標錯了才用；已有收回紀錄的要改用沖銷'; cn.onclick = function () { cancelAdvanceUi(a); }; op.appendChild(cn); }
        tr.appendChild(op); t.appendChild(tr);
        if (advState.open[a.advanceId]) {
          var dr = el('tr'), dt = el('td', { colspan: '11', style: 'background:#f6f8fb' }), bx = el('div', { style: 'padding:6px 4px' });
          bx.appendChild(el('div', {}, '標記人：' + (a.createdBy || '') + '　代墊日：' + a.advancedAt));
          bx.appendChild(el('div', {}, '備註：' + (a.note || '（無）')));
          bx.appendChild(el('div', {}, '收回來源：' + (a.recoveredBy || (a.recovered ? '' : '（尚未收回）'))));
          if (a.overdue) bx.appendChild(el('div', { style: 'color:#b42318' }, '逾期原因：' + [(a.overdueReasons && a.overdueReasons.days) ? '已代墊超過 ' + d.overdueDays + ' 天仍未收回' : '', (a.overdueReasons && a.overdueReasons.nextBill) ? '下期請款單（' + a.overdueReasons.nextBill + ' 帳期）已匯入，但沒有補收這筆代墊' : ''].filter(Boolean).join('；')));
          var BS = { UNPAID: '未收', REPORTED: '客戶已回報', PARTIAL: '部分收款', DIFF: '多收', RECONCILED: '已對帳', RESOLVED: '已處理' };
          (a.links || []).forEach(function (l) { bx.appendChild(el('div', {}, '補收項目：' + l.billingPeriod + ' 帳期請款單 ' + money(l.amount) + ' 元（請款單' + (BS[l.billStatus] || l.billStatus) + (l.billStatus === 'RECONCILED' ? '，已計入收回' : '，對帳完成後才計入收回') + '）')); });
          dt.appendChild(bx); dr.appendChild(dt); t.appendChild(dr);
        }
      });
      var fr = el('tr', { style: 'font-weight:600' });
      fr.appendChild(el('td', { colspan: '4' }, '合計（' + list.length + ' 筆）'));
      fr.appendChild(el('td', { class: 'num' }, money(tot.amount))); fr.appendChild(el('td', { colspan: '2' }, ''));
      fr.appendChild(el('td', { class: 'num' }, tot.recovered ? money(tot.recovered) : '')); fr.appendChild(el('td', { class: 'num' }, tot.remaining ? money(tot.remaining) : '')); fr.appendChild(el('td', { colspan: '2' }, ''));
      t.appendChild(fr);
      var sc = el('div', { class: 'scrollx' }); sc.appendChild(t); tbl.appendChild(sc);
    }
    paint();
  }

  function writeOffDialog(a) {
    var m = openModal('沖銷代墊');
    m.appendChild(el('div', { class: 'muted' }, a.companyId + ' ' + a.name + '　' + (a.periodLabel || '') + ' ' + (ADV_TAX[a.taxType] || '') + '　代墊 ' + money(a.amount) + (a.recovered ? '，已收回 ' + money(a.recovered) : '') + '　→　還剩 ' + money(a.remaining) + ' 元'));
    m.appendChild(el('p', {}, '沖銷＝決定不再收回這筆代墊（例如客戶結束營業、金額很小決定吸收）。沖銷後這筆不再算未收回、也不會再提醒逾期。'));
    var note = el('input', { type: 'text', maxlength: '200', placeholder: '為什麼不再收回（必填）' });
    field(m, '備註', note);
    modalActions(m, '確定沖銷', function (fail) {
      if (note.value.trim().length < 2) return fail('請填沖銷備註');
      call('bank.writeOffAdvance', { advanceId: a.advanceId, note: note.value.trim() }, function () { closeModal(); loadAdvances(advState.status); }, function (e) { fail(e.message); });
    });
  }

  function cancelAdvanceUi(a) {
    if (!confirm('取消「' + a.name + ' ' + (a.periodLabel || '') + '」先代墊 ' + money(a.amount) + ' 元的標記？（標錯了才用；取消後可重新標記）')) return;
    call('bank.cancelAdvance', { advanceId: a.advanceId }, function () { loadAdvances(advState.status); if (taxData && taxData.period) loadTax(taxData.period.periodId); }, function (e) { alert(e.message); });
  }

  /** 稅務申報頁公司視窗裡的「先代墊」區塊：已標記顯示狀態與取消標記；未標記顯示按鈕；其他期還有未收回的代墊先提醒 */
  function advanceBlock(m, r) {
    var canEdit = taxData.caps.canWrite;
    m.appendChild(el('div', { class: 'card-title' }, '先代墊'));
    var box = el('div', { style: 'margin-bottom:12px' });
    var others = r.otherAdvances || [];
    if (others.length) {
      var sum = others.reduce(function (s, a) { return s + a.remaining; }, 0);
      box.appendChild(el('div', { class: 'alert', style: 'margin-bottom:8px' }, '這家客戶還有 ' + others.length + ' 筆未收回的代墊，合計還剩 ' + money(sum) + ' 元（' + others.map(function (a) { return a.advancedAt.slice(5) + ' 代墊 ' + money(a.amount); }).join('、') + '）。再次代墊前請先確認；最後由您決定。'));
    }
    if (r.advance) {
      var a = r.advance, s = ADV_STATUS[a.status] || [a.status, 'off'];
      var line = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' });
      line.appendChild(el('span', {}, '本期已先代墊 ' + money(a.amount) + ' 元（代墊日 ' + a.advancedAt + (a.recovered ? '，已收回 ' + money(a.recovered) : '') + '）'));
      line.appendChild(badge(s[0], s[1]));
      if (a.status === 'OPEN' && !a.recovered) {
        var cb = el('button', { class: 'btn small secondary' }, '取消標記'); cb.disabled = !canEdit; cb.title = '標錯了才用';
        cb.onclick = function () {
          if (!confirm('取消本期先代墊 ' + money(a.amount) + ' 元的標記？')) return;
          call('bank.cancelAdvance', { advanceId: a.advanceId }, function () { closeModal(); loadTax(taxData.period.periodId); }, function (e) { alert(e.message); });
        };
        line.appendChild(cb);
      }
      box.appendChild(line);
    } else {
      var mb = el('button', { class: 'btn small' }, '標記先代墊'); mb.disabled = !canEdit || !r.applicable;
      mb.onclick = function () { advanceMarkDialog(r); };
      box.appendChild(mb);
      box.appendChild(el('span', { class: 'muted', style: 'margin-left:8px' }, '客戶晚匯或少匯、您決定先替他繳稅時按（系統不會自動代墊；還沒對帳也可以標）。'));
    }
    m.appendChild(box);
  }

  function advanceMarkDialog(r) {
    var m = openModal('標記先代墊：' + (r.shortName || r.companyName));
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, r.companyId + '　' + taxData.period.label + '　稅額 ' + (r.taxAmount === null || r.taxAmount === undefined ? '（尚未計算）' : money(r.taxAmount) + ' 元')));
    var others = r.otherAdvances || [];
    if (others.length) m.appendChild(el('div', { class: 'alert', style: 'margin-bottom:8px' }, '提醒：這家客戶還有 ' + others.length + ' 筆未收回的代墊，合計還剩 ' + money(others.reduce(function (s, a) { return s + a.remaining; }, 0)) + ' 元。'));
    var amt = el('input', { type: 'number', min: '1', style: 'width:160px' }); amt.value = r.taxAmount > 0 ? String(r.taxAmount) : '';
    var dt = el('input', { type: 'date', style: 'width:auto' }); dt.value = todayStr();
    var note = el('input', { type: 'text', maxlength: '200', placeholder: '選填' });
    field(m, '代墊金額（元）', amt, '預設帶本期稅額，可修改。');
    field(m, '代墊日', dt);
    field(m, '備註', note);
    modalActions(m, '標記', function (fail) {
      var n = Number(amt.value);
      if (!Number.isInteger(n) || n <= 0) return fail('代墊金額要填大於 0 的整數');
      var args = { filingId: r.filingId, amount: n, advancedAt: dt.value || undefined, note: note.value.trim() };
      function send(force) {
        if (force) args.force = true;
        call('bank.markAdvance', args, function (res) {
          closeModal();
          if (res && res.alreadyRecovered) alert('已標記，但這一期的請款單已全額對帳，所以這筆代墊直接顯示為「已收回」。');
          loadTax(taxData.period.periodId);
        }, function (e) {
          if (e.code === 'ALREADY_PAID' && confirm(e.message)) return send(true);
          fail(e.message);
        });
      }
      send(false);
    });
  }

  /** 稅務模組設定頁（僅超管）：代墊逾期天數 */
  function renderAdvanceSettings() {
    var box = $('setAdvBox'); box.innerHTML = '';
    call('bank.getAdvanceSettings', {}, function (r) {
      var c = el('div', { class: 'card' }), s = { overdueDays: r.overdueDays };
      c.appendChild(el('div', { class: 'card-title' }, '先代墊逾期天數'));
      if (!r.canWrite) c.appendChild(el('div', { class: 'alert' }, '系統同步異常，目前只能查看，不能儲存。'));
      var inp = el('input', { type: 'number', min: '1', max: '365', style: 'width:120px' }); inp.value = s.overdueDays; inp.oninput = function () { s.overdueDays = Number(inp.value); };
      field(c, '代墊超過幾天還沒收回就標示逾期', inp, '預設 ' + r.defaultOverdueDays + ' 天；逾期的代墊會在「收款對帳 → 代墊帳款」標紅色「逾期」。');
      var save = el('button', { class: 'btn' }, '儲存'); save.disabled = !r.canWrite;
      var out = el('span', { class: 'muted', style: 'margin-left:10px' });
      save.onclick = function () {
        save.disabled = true; out.textContent = '儲存中…';
        call('bank.saveAdvanceSettings', s, function () { save.disabled = false; out.textContent = '已儲存'; }, function (e) { save.disabled = false; out.textContent = e.message; });
      };
      c.appendChild(save); c.appendChild(out); box.appendChild(c);
    }, function (e) { box.textContent = e.message; });
  }

  function showBankPage() {
    var hasBank = me && (me.role === 'SUPER_ADMIN' || (me.features || []).indexOf('BANK_RECONCILIATION') >= 0);
    if (!hasBank && bankTab !== 'advance') bankTab = 'ledger'; // 只有稅務申報權限者只看得到客戶帳款表與代墊帳款
    var tabs = $('bankTabs'); tabs.innerHTML = '';
    (hasBank ? [['ledger', '客戶帳款表'], ['stmt', '匯入銀行明細'], ['alias', '客戶資料'], ['advance', '代墊帳款']] : [['ledger', '客戶帳款表'], ['advance', '代墊帳款']]).forEach(function (t) {
      var b = el('button', { class: 'btn small' + (bankTab === t[0] ? '' : ' secondary') }, t[1]);
      b.onclick = function () { bankTab = t[0]; showBankPage(); }; tabs.appendChild(b);
    });
    $('bankStmtView').classList.toggle('hidden', bankTab !== 'stmt');
    $('bankLedgerView').classList.toggle('hidden', bankTab !== 'ledger');
    $('bankAliasView').classList.toggle('hidden', bankTab !== 'alias');
    $('bankAdvanceView').classList.toggle('hidden', bankTab !== 'advance');
    if (bankTab === 'alias') loadBank(); else if (bankTab === 'advance') loadAdvances(); else if (bankTab === 'ledger') loadLedger(); else if (bs && bs.rows) reloadCtx(); else renderStmtStart();
  }
  var bankTab = 'ledger';

  function renderStmtStart() {
    var box = $('bankStmtView');
    if (bs && bs.rows) { renderStmt(); return; }
    box.innerHTML = '';
    var dz = el('div', { class: 'card', style: 'border:2px dashed #98a2b3;text-align:center;padding:28px' });
    dz.appendChild(document.createTextNode('把台新交易明細 Excel 拖到這裡，或 '));
    var pick = el('button', { class: 'btn small' }, '選擇檔案'), fi = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'hidden' });
    dz.appendChild(pick); dz.appendChild(fi);
    dz.appendChild(el('div', { class: 'muted', style: 'margin-top:6px' }, '檔案只在這個頁面的記憶體讀取與比對，不會上傳或儲存；按「送出確認結果」後，只有對帳結果（日期、金額、匯費、對到哪張請款單）會寫入。匯入的日期區間可以重疊，已處理過的交易不會再出現。'));
    var msg = el('div', { class: 'muted', style: 'margin-top:8px' });
    box.appendChild(dz); box.appendChild(msg);
    wireDropZone(dz, fi, pick, /\.xlsx?$/i, false, function (files) { startStatement(files[0], msg); });
    box.appendChild(recentBox());
  }

  /** 讀檔 → 算檢查碼 → 取比對資料 → 比對 */
  function startStatement(file, msg) {
    msg.textContent = '讀取中…';
    readBankFile(file).then(function (r) {
      if (!r.ok) { msg.textContent = ''; msg.appendChild(el('span', { class: 'msg err' }, r.message)); return; }
      if (!r.txns.length) { msg.textContent = '這份明細沒有存入或繳費轉出的交易。'; return; }
      var dts = r.txns.map(function (t) { return t.dt.slice(0, 10); }).sort();
      var seqOf = {};
      var fromDef = defaultFrom(dts[dts.length - 1]);
      return Promise.all(r.txns.map(function (t) { return sha256Hex(window.YcBank.txnKeyText(t)); })).then(function (keys) {
        r.txns.forEach(function (t, i) { t.key = keys[i]; seqOf[t.key] = (seqOf[t.key] || 0) + 1; t.seq = seqOf[t.key]; });
        msg.textContent = '取得比對資料…';
        call('bank.getContext', { from: fromDef < dts[0] ? dts[0] : fromDef, to: dts[dts.length - 1] }, function (ctx) {
          bs = { fileName: file.name, txns: r.txns, ctx: ctx, ctxAt: new Date(), tab: 'exact', rows: null, sug: null, from: fromDef < dts[0] ? dts[0] : fromDef, minDate: dts[0], maxDate: dts[dts.length - 1] };
          buildRows(); renderStmt();
        }, function (e) { msg.textContent = ''; msg.appendChild(el('span', { class: 'msg err' }, e.message)); });
      });
    }, function (e) { msg.textContent = ''; msg.appendChild(el('span', { class: 'msg err' }, e.message || '讀取失敗')); });
  }

  /** 依目前的比對資料重算所有列（送出後、加入新來源後都會重算） */
  function buildRows() {
    var ctx = bs.ctx, set = ctx.settings, handled = {};
    ctx.handled.forEach(function (h) { handled[h] = 1; });
    var priorMarks = {}; (ctx.marks || []).forEach(function (m) { priorMarks[m.key + '#' + m.seq] = m.mark; });
    var prev = {}; (bs.rows || []).forEach(function (r) { prev[r.tx.key + '#' + r.tx.seq] = r; });
    bs.beforeN = bs.txns.filter(function (tx) { return !inScopeTx(tx); }).length;
    var rows = bs.txns.filter(inScopeTx).map(function (tx) {
      var p = window.YcBank.parseMemo(tx.summary, tx.memo);
      var kind = window.YcBank.classify(tx, { keywords: set.nonCustomerKeywords, categories: catKinds(set.taxPayCategories) });
      var old = prev[tx.key + '#' + tx.seq];
      return { tx: tx, p: p, kind: kind, priorMark: priorMarks[tx.key + '#' + tx.seq] || '', done: !!handled[tx.key + '#' + tx.seq], mark: old && old.mark && !handled[tx.key + '#' + tx.seq] ? old.mark : '', manual: old && old.manual ? old.manual : null, learn: old ? old.learn : true, ticked: old && old.touched ? old.ticked : null, touched: !!(old && old.touched), match: null };
    });
    var cust = rows.filter(function (r) { return r.kind === 'CUSTOMER_PAYMENT' && !r.done && !r.mark; });
    var matchTxns = cust.filter(function (r) { return !r.manual; }).map(function (r, i) { r.mid = 'c' + i; return { id: r.mid, amount: r.tx.amount, date: dateMs(r.tx.dt), payerAccount: r.p.payerAccount, payerName: r.p.payerName || r.p.freeText, payerTag: r.p.payerTag }; });
    // 手動指定過的請款單不再給其他交易使用
    var taken = {}; cust.forEach(function (r) { if (r.manual) r.manual.allocations.forEach(function (a) { taken[a.billId] = 1; }); });
    var bills = ctx.bills.filter(function (b) { return !taken[b.billId]; }).map(function (b) { return { billId: b.billId, companyId: b.companyId, amount: b.remaining }; });
    var res = window.YcMatch.matchPayments(matchTxns, bills, ctx.companies, ctx.aliases, { fee: set.fee, splitDays: set.splitDays, comboMax: set.comboMax, autoConfirm: set.autoConfirm });
    var byMid = {}; res.forEach(function (x) { byMid[x.txnId] = x; });
    cust.forEach(function (r) { r.match = r.manual ? r.manual : byMid[r.mid]; if (r.ticked === null || r.ticked === undefined) r.ticked = r.match.status === 'CONFIRMED'; });
    var taxRows = rows.filter(function (r) { return r.kind === 'TAX_PAYMENT' && !r.done && !r.mark; });
    var kindOf = catKinds(set.taxPayCategories);
    var tres = window.YcMatch.matchTaxPayments(taxRows.map(function (r, i) { r.mid = 't' + i; return { id: r.mid, amount: -r.tx.amount, refNo7: r.p.taxRefNo7, kind: (kindOf[r.p.taxPayCategory] || {}).kind === 'PREPAY' ? 'PREPAY' : 'VAT' }; }), ctx.filings);
    taxRows.forEach(function (r, i) { r.match = tres[i]; if (r.ticked === null || r.ticked === undefined) r.ticked = r.match.status === 'CONFIRMED'; });
    bs.rows = rows;
    bs.sug = null;
  }
  function catKinds(cats) { var o = {}; Object.keys(cats || {}).forEach(function (k) { o[k] = { kind: cats[k].kind }; }); return o; }

  function tabOf(r) {
    if (r.done || r.mark || r.kind === 'NON_CUSTOMER') return 'done';
    if (r.kind === 'OTHER_TAX_PAYMENT') return 'othertax';
    if (r.kind === 'TAX_PAYMENT') return 'tax';
    var s = r.match && r.match.status;
    return s === 'CONFIRMED' ? 'exact' : (s === 'PROPOSED' ? 'propose' : 'unmatched');
  }
  function companyName(id) { var c = bs.ctx.companies.filter(function (x) { return x.companyId === id; })[0]; return c ? id + ' ' + (c.shortName || c.name) : id; }
  function billLabel(id) { var b = bs.ctx.bills.filter(function (x) { return x.billId === id; })[0]; return b ? (b.kind && b.kind !== 'GENERAL' ? ({ PREPAY: '暫繳', CIT: '營所稅', PIT: '綜所稅', UNDIST: '未分配盈餘稅' }[b.kind] || b.kind) : '請款單') + ' ' + b.billingPeriod + '（待收 ' + money(b.remaining) + '）' : id; }
  function payerText(r) {
    var parts = [];
    if (r.p.payerTag) parts.push('標註 ' + r.p.payerTag);
    if (r.p.payerName) parts.push(r.p.payerName);
    if (r.p.payerAccount) parts.push('帳號 …' + r.p.payerAccount.slice(-4));
    if (r.p.freeText && !r.p.payerName) parts.push(r.p.freeText);
    return parts.join('　');
  }

  function renderStmt() {
    var box = $('bankStmtView'); box.innerHTML = '';
    var rows = bs.rows;
    var head = el('div', { class: 'toolbar' });
    head.appendChild(el('strong', {}, bs.fileName));
    var again = el('button', { class: 'btn small secondary' }, '重新選檔（捨棄目前畫面）'); again.onclick = function () { if (!confirm('目前畫面上尚未送出的勾選與指定都會捨棄。確定重新選檔？')) return; bs = null; renderStmtStart(); };
    head.appendChild(again);
    var refresh = el('button', { class: 'btn small secondary' }, '重新取得請款單與客戶資料');
    refresh.title = '剛匯入請款單、剛加入客戶資料、或別人剛送出對帳時按這個（不用重新選檔）';
    refresh.onclick = function () { refresh.disabled = true; reloadCtx(); };
    head.appendChild(refresh);
    var at = bs.ctxAt ? bs.ctxAt.getHours() + ':' + ('0' + bs.ctxAt.getMinutes()).slice(-2) : '';
    head.appendChild(el('span', { class: 'muted' }, '比對資料取得時間 ' + at + '（待收請款單 ' + bs.ctx.bills.length + ' 張、客戶資料 ' + bs.ctx.aliases.length + ' 筆）'));
    box.appendChild(head);
    var dateBar = el('div', { class: 'toolbar' });
    dateBar.appendChild(document.createTextNode('只處理這個日期之後的交易（含當天）：'));
    var dIn = el('input', { type: 'date', style: 'width:auto' }); dIn.value = bs.from.replace(/\//g, '-'); dIn.min = bs.minDate.replace(/\//g, '-'); dIn.max = bs.maxDate.replace(/\//g, '-');
    dIn.onchange = function () { if (!dIn.value) return; bs.from = dIn.value; reloadCtx(); };
    dateBar.appendChild(dIn);
    dateBar.appendChild(el('span', { class: 'muted' }, '預設是檔案最後一筆往前 60 天；更早的 ' + bs.beforeN + ' 筆不列出、不處理、也不會被標記。'));
    box.appendChild(dateBar);
    var counts = {}; rows.forEach(function (r) { var t = tabOf(r); counts[t] = (counts[t] || 0) + 1; });
    var doneN = rows.filter(function (r) { return r.done; }).length;
    box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' }, '處理範圍內共 ' + rows.length + ' 筆（存入與繳費轉出）；先前已處理 ' + doneN + ' 筆不再列出。交易明細只在這個頁面，關閉或重新整理就消失。'));
    if (!bs.ctx.canWrite) box.appendChild(el('div', { class: 'alert' }, '唯讀模式：系統同步異常，暫時無法送出。'));
    renderSuggestions(box);
    var tabs = el('div', { class: 'toolbar' });
    BANK_TABS.forEach(function (t) {
      var b = el('button', { class: 'btn small' + (bs.tab === t[0] ? '' : ' secondary') }, t[1] + '（' + (counts[t[0]] || 0) + '）');
      b.onclick = function () { bs.tab = t[0]; renderStmt(); }; tabs.appendChild(b);
    });
    box.appendChild(tabs);
    var list = rows.filter(function (r) { return tabOf(r) === bs.tab; });
    var card = el('div', { class: 'card' }); box.appendChild(card);
    if (bs.tab === 'done') card.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' }, '以前標記過「略過」或「非客戶」的交易，可按「恢復成待處理」讓它重新出現。雲端不存交易內容，所以要先載入那份明細才看得到。已確認收款的交易要撤銷，請用頁面下方「近期已確認」的取消確認。'));
    if (!list.length) card.appendChild(el('div', { class: 'muted' }, bs.tab === 'exact' ? '沒有完全相符的項目。' : '這一類沒有項目。'));
    else {
      var t = el('table', { class: 'auto' }), h = el('tr');
      [(bs.tab === 'exact' || bs.tab === 'propose' || bs.tab === 'tax') ? '送出' : '', '日期', '金額', '付款人', '比對結果', ''].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      list.forEach(function (r) { t.appendChild(rowTr(r)); });
      card.appendChild(t);
    }
    var foot = el('div', { class: 'actions', style: 'align-items:center;margin-top:8px' }), msgBox = el('span', { class: 'muted' });
    var pickN = rows.filter(function (r) { return sendable(r); }).length, markN = rows.filter(function (r) { return r.mark && !r.done; }).length;
    var send = el('button', { class: 'btn' }, '送出確認結果（' + pickN + ' 筆' + (markN ? '、標記 ' + markN + ' 筆' : '') + '）');
    send.disabled = !bs.ctx.canWrite || (!pickN && !markN);
    send.onclick = function () { submitRows(send, msgBox); };
    foot.appendChild(msgBox); foot.appendChild(send); box.appendChild(foot);
    box.appendChild(recentBox());
  }
  function sendable(r) { return r.ticked && !r.done && !r.mark && r.match && (r.match.status === 'CONFIRMED' || r.match.status === 'PROPOSED') && r.match.allocations.length > 0; }

  function rowTr(r) {
    var tr = el('tr'), tab = tabOf(r);
    var td0 = el('td');
    if (tab === 'exact' || tab === 'propose' || tab === 'tax') {
      var cb = el('input', { type: 'checkbox' }); cb.checked = !!r.ticked && !!r.match && r.match.allocations.length > 0; cb.disabled = !r.match || !r.match.allocations.length;
      cb.onchange = function () { r.ticked = cb.checked; r.touched = true; renderStmt(); }; td0.appendChild(cb);
    }
    tr.appendChild(td0);
    tr.appendChild(el('td', {}, r.tx.dt.slice(5, 16)));
    tr.appendChild(el('td', { style: 'text-align:right' }, money(Math.abs(r.tx.amount))));
    var pt = el('td', {}, payerText(r)); if (r.kind === 'CUSTOMER_PAYMENT' && r.match && !r.match.known && r.match.status !== 'UNMATCHED') pt.appendChild(badge('來源未知', 'warn'));
    tr.appendChild(pt);
    var rs = el('td');
    if (r.kind === 'CUSTOMER_PAYMENT' && r.match && r.match.allocations.length) {
      r.match.allocations.forEach(function (a) {
        var line = el('div'); line.appendChild(document.createTextNode(companyName(a.companyId) + '　' + billLabel(a.billId) + '　入帳 ' + money(a.allocated)));
        if (a.fee > 0) { var bd = badge('匯費 ' + a.fee, 'warn'); var b = bs.ctx.bills.filter(function (x) { return x.billId === a.billId; })[0]; bd.title = '待收 ' + money(b ? b.remaining : a.allocated + a.fee) + ' − 入帳 ' + money(a.allocated) + ' = 匯費 ' + a.fee + ' 元（視為匯費免收）'; line.appendChild(bd); }
        if (r.match.overHabit) line.appendChild(badge('超過平常匯費 ' + r.match.overHabit + ' 元，請確認', 'err'));
        rs.appendChild(line);
      });
      rs.appendChild(el('div', { class: 'muted' }, RULE_LABEL[r.match.rule] || r.match.rule));
    } else if (r.kind === 'CUSTOMER_PAYMENT') rs.appendChild(el('span', { class: 'muted' }, r.done ? (r.priorMark === 'IGNORED' ? '先前標記：略過' : (r.priorMark === 'NON_CUSTOMER' ? '先前標記：非客戶款項' : '已確認收款（要撤銷請用下方「近期已確認」的取消確認）')) : (r.mark ? (r.mark === 'IGNORED' ? '已標記略過（尚未送出）' : '已標記非客戶款項（尚未送出）') : '對不到')));
    else if (r.kind === 'TAX_PAYMENT') {
      var m = r.match;
      if (m.allocations.length) rs.appendChild(document.createTextNode(companyName(m.allocations[0].companyId) + '　' + m.note + ' 應納稅額 ' + money(m.allocations[0].allocated)));
      else rs.appendChild(el('span', { class: 'muted' }, m.note || (m.status === 'INFO' ? '' : '對不到')));
    } else if (r.kind === 'OTHER_TAX_PAYMENT') rs.appendChild(el('span', { class: 'muted' }, '其他代繳稅款（例如代扣所得稅，目前不對帳）'));
    else if (r.kind === 'NON_CUSTOMER') rs.appendChild(el('span', { class: 'muted' }, '非客戶款項（股息、利息等）'));
    tr.appendChild(rs);
    var op = el('td');
    if (r.kind === 'CUSTOMER_PAYMENT' && !r.done) {
      if (!r.mark) {
        var pick = el('button', { class: 'linkbtn' }, tab === 'unmatched' ? '指定客戶' : '改選'); pick.onclick = function () { chooseDialog(r); }; op.appendChild(pick);
        var ig = el('button', { class: 'linkbtn' }, '略過'); ig.onclick = function () { r.mark = 'IGNORED'; renderStmt(); }; op.appendChild(ig);
        var nc = el('button', { class: 'linkbtn' }, '非客戶'); nc.onclick = function () { r.mark = 'NON_CUSTOMER'; renderStmt(); }; op.appendChild(nc);
      } else { var un = el('button', { class: 'linkbtn' }, '還原'); un.onclick = function () { r.mark = ''; renderStmt(); }; op.appendChild(un); }
    }
    if (r.done && r.priorMark) {
      var rc = el('button', { class: 'linkbtn' }, '恢復成待處理'); rc.title = '清除「' + (r.priorMark === 'IGNORED' ? '略過' : '非客戶') + '」標記，這筆交易會重新出現在「未對上」或「建議」';
      rc.onclick = function () {
        if (!confirm('恢復後，這筆交易會重新出現在「未對上」或「建議」，不影響任何請款單。確定嗎？')) return;
        rc.disabled = true;
        call('bank.clearMarks', { items: [{ txnKey: r.tx.key, txnSeq: r.tx.seq }] }, function () { reloadCtx(); }, function (e) { rc.disabled = false; alert(e.message); });
      };
      op.appendChild(rc);
    }
    tr.appendChild(op);
    return tr;
  }

  /** 指定／改選客戶：可選一家或多家公司（一筆款付多家），每家列出待收請款單，填各張分配金額（合計＝交易金額） */
  function chooseDialog(r) {
    var m = openModal('指定客戶與請款單'); $('modal').style.width = 'min(800px,96vw)';
    m.appendChild(el('div', { class: 'muted' }, r.tx.dt.slice(0, 16) + '　金額 ' + money(r.tx.amount) + '　' + payerText(r)));
    var blocksBox = el('div'), blocks = [], info = el('div', { class: 'msg err' }), sumLine = el('div', { style: 'font-weight:600;margin:6px 0' });
    var used = {}; bs.rows.forEach(function (x) { if (x !== r && x.manual) x.manual.allocations.forEach(function (a) { used[a.billId] = 1; }); });
    var prev = {}; if (r.manual) r.manual.allocations.forEach(function (a) { prev[a.billId] = a.allocated; });
    var left = r.manual ? 0 : r.tx.amount;
    function paintSum() {
      var sum = 0; blocks.forEach(function (b) { b.inputs.forEach(function (x) { sum += Math.round(Number(x[1].value) || 0); }); });
      sumLine.textContent = '分配合計 ' + money(sum) + '／交易金額 ' + money(r.tx.amount) + (sum === r.tx.amount ? '　✔' : '　（必須相等）');
    }
    function addBlock(companyId) {
      var blk = { inputs: [], comp: el('select') }, card = el('div', { class: 'card', style: 'margin:8px 0' }), box = el('div');
      blk.comp.appendChild(el('option', { value: '' }, '請選擇公司'));
      bs.ctx.companies.forEach(function (c) { blk.comp.appendChild(el('option', { value: c.companyId }, c.companyId + ' ' + (c.shortName || c.name))); });
      blk.comp.value = companyId || '';
      function paint() {
        box.innerHTML = ''; blk.inputs = [];
        if (!blk.comp.value) { paintSum(); return; }
        var other = {}; blocks.forEach(function (b) { if (b !== blk) b.inputs.forEach(function (x) { other[x[0].billId] = 1; }); });
        var bills = bs.ctx.bills.filter(function (b) { return b.companyId === blk.comp.value && !used[b.billId] && !other[b.billId]; });
        if (!bills.length) { box.appendChild(el('div', { class: 'muted' }, '這家公司目前沒有待收的請款單。')); paintSum(); return; }
        var t = el('table', { class: 'auto' }), h = el('tr'); ['請款單', '待收', '分配金額'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
        bills.forEach(function (b) {
          var tr = el('tr'); tr.appendChild(el('td', {}, billLabel(b.billId).replace(/（待收.*$/, ''))); tr.appendChild(el('td', {}, money(b.remaining)));
          var inp = el('input', { type: 'number', min: '0', style: 'width:120px' });
          var pre = r.manual ? (prev[b.billId] || 0) : Math.min(left, b.remaining);
          if (!r.manual) left -= pre;
          inp.value = pre > 0 ? pre : ''; inp.oninput = paintSum;
          var td = el('td'); td.appendChild(inp); tr.appendChild(td); t.appendChild(tr); blk.inputs.push([b, inp]);
        });
        box.appendChild(t); paintSum();
      }
      blk.comp.onchange = function () { left = 0; paint(); };
      var top = el('div', { class: 'toolbar' }); top.appendChild(blk.comp);
      var rm = el('button', { class: 'linkbtn' }, '移除這家'); rm.onclick = function () { blocks.splice(blocks.indexOf(blk), 1); card.remove(); paintSum(); };
      if (blocks.length) top.appendChild(rm);
      card.appendChild(top); card.appendChild(box); blocksBox.appendChild(card); blocks.push(blk); paint();
    }
    var first = r.manual ? r.manual.allocations.map(function (a) { return a.companyId; }).filter(function (c, i, arr) { return arr.indexOf(c) === i; })
      : (r.match && r.match.allocations.length ? [r.match.allocations[0].companyId] : ['']);
    first.forEach(addBlock);
    m.appendChild(blocksBox);
    var more = el('button', { class: 'btn small secondary' }, '＋ 再加一家公司（一筆款付多家時）'); more.onclick = function () { left = 0; addBlock(''); };
    m.appendChild(more); m.appendChild(sumLine);
    var learnCb = el('input', { type: 'checkbox' }); learnCb.checked = r.learn !== false;
    var learnLab = el('label', { style: 'display:flex;gap:6px;align-items:center;margin-top:8px' }); learnLab.appendChild(learnCb);
    learnLab.appendChild(el('span', {}, '把這個客戶資料加入對照（' + [r.p.payerTag && '標註 ' + r.p.payerTag, r.p.payerAccount && '帳號 ' + r.p.payerAccount, r.p.payerName && '戶名 ' + r.p.payerName].filter(Boolean).join('、') + '），下次自動認得；選了多家公司就對每一家都加'));
    m.appendChild(learnLab); m.appendChild(info);
    var acts = el('div', { class: 'actions' }), cancel = el('button', { class: 'btn secondary' }, '取消'), ok = el('button', { class: 'btn' }, '確定');
    cancel.onclick = closeModal;
    ok.onclick = function () {
      info.textContent = '';
      var allocs = [], sum = 0, tol = bs.ctx.settings.fee;
      blocks.forEach(function (b) { b.inputs.forEach(function (x) { var v = Math.round(Number(x[1].value) || 0); if (v > 0) { sum += v; var fee = x[0].remaining - v; allocs.push({ billId: x[0].billId, companyId: x[0].companyId, allocated: v, fee: fee >= 1 && fee <= tol ? fee : 0 }); } }); });
      if (!allocs.length) { info.textContent = '請選擇公司並填寫分配金額。'; return; }
      if (sum !== r.tx.amount) { info.textContent = '分配金額合計 ' + money(sum) + ' 與交易金額 ' + money(r.tx.amount) + ' 不符。'; return; }
      r.manual = { status: 'PROPOSED', rule: 'MANUAL', known: true, allocations: allocs }; r.learn = learnCb.checked; r.ticked = true; r.touched = true;
      closeModal(); buildRows(); renderStmt();
    };
    acts.appendChild(cancel); acts.appendChild(ok); m.appendChild(acts);
  }

  /** 新來源建議（M2 6.2 入口一）：這份明細裡帳號、戶名、標註還不在客戶資料裡的，列出來讓業主一次加入 */
  function renderSuggestions(box) {
    var have = {}; bs.ctx.aliases.forEach(function (a) { have[a.type + '|' + a.value] = 1; });
    var combos = {}, list = [];
    bs.rows.forEach(function (r) {
      if (r.kind !== 'CUSTOMER_PAYMENT' || r.done || (!r.p.payerTag && !r.p.payerAccount && !r.p.payerName)) return;
      var isNew = (r.p.payerTag && !have['TAG|' + r.p.payerTag]) || (r.p.payerAccount && !have['ACCOUNT|' + r.p.payerAccount]) || (r.p.payerName && !have['NAME|' + r.p.payerName]);
      if (!isNew || !r.p.payerTag) return; // 沒有標註的來源，等對帳時由業主指定客戶後一併加入
      var k = r.p.payerTag + '\u0001' + r.p.payerAccount + '\u0001' + r.p.payerName;
      if (!combos[k]) { combos[k] = { tag: r.p.payerTag, account: r.p.payerAccount, name: r.p.payerName, count: 0 }; list.push(combos[k]); }
      combos[k].count++;
    });
    if (!list.length) return;
    var panel = el('details', { class: 'card', style: 'margin-bottom:8px' });
    panel.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600' }, '新來源建議（' + list.length + ' 組尚未記在客戶資料裡）'));
    var body = el('div'); panel.appendChild(body); box.appendChild(panel);
    var loaded = false;
    panel.addEventListener('toggle', function () {
      if (!panel.open || loaded) return; loaded = true; body.textContent = '比對公司中…';
      call('bank.suggestAliases', { combos: list }, function (d) { renderSug(body, d); }, function (e) { body.textContent = e.message; });
    });
  }
  function renderSug(body, d) {
    body.innerHTML = '';
    var pick = {};
    var t = el('table', { class: 'auto' }), h = el('tr'); ['加入', '標註', '次數', '對到公司'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
    d.groups.forEach(function (g) {
      var tr = el('tr'), td = el('td');
      var cell = el('td');
      if (g.status === 'AUTO' || g.status === 'COMBO') {
        var ids = g.candidates.map(function (c) { return c.companyId; });
        pick[g.tag] = g.alreadyHas ? [] : ids;
        var cb = el('input', { type: 'checkbox' }); cb.checked = !g.alreadyHas; cb.onchange = function () { pick[g.tag] = cb.checked ? ids : []; };
        td.appendChild(cb); cell.appendChild(document.createTextNode(g.candidates.map(function (c) { return c.companyId + ' ' + c.name; }).join('、') + (g.status === 'COMBO' ? '（標註含多家）' : (g.how === 'prefix' ? '（開頭相符）' : ''))));
      } else {
        var s = el('select'); s.appendChild(el('option', { value: '' }, '— 不加入 —'));
        d.companies.forEach(function (c) { s.appendChild(el('option', { value: c.id }, c.id + ' ' + c.name)); });
        s.onchange = function () { pick[g.tag] = s.value ? [s.value] : []; }; cell.appendChild(s);
      }
      tr.appendChild(td); tr.appendChild(el('td', {}, g.tag)); tr.appendChild(el('td', {}, String(g.count))); tr.appendChild(cell); t.appendChild(tr);
    });
    body.appendChild(t);
    var msg = el('div', { class: 'msg err' }), go1 = el('button', { class: 'btn small' }, '加入勾選的來源'); go1.disabled = !d.canWrite;
    go1.onclick = function () {
      var items = [];
      d.groups.forEach(function (g) { (pick[g.tag] || []).forEach(function (cid) { items.push({ companyId: cid, tag: g.tag, accounts: g.accounts, names: g.names }); }); });
      if (!items.length) { msg.textContent = '沒有勾選任何來源。'; return; }
      go1.disabled = true;
      call('bank.addAliases', { items: items }, function (r) {
        items.forEach(function (it) { bs.ctx.aliases.push({ companyId: it.companyId, type: 'TAG', value: it.tag, status: 'ACTIVE' }); it.accounts.forEach(function (a) { bs.ctx.aliases.push({ companyId: it.companyId, type: 'ACCOUNT', value: a, status: 'ACTIVE' }); }); it.names.forEach(function (a) { bs.ctx.aliases.push({ companyId: it.companyId, type: 'NAME', value: a, status: 'ACTIVE' }); }); });
        alert('已加入 ' + r.added + ' 筆客戶資料。'); buildRows(); renderStmt();
      }, function (e) { go1.disabled = false; msg.textContent = e.message; });
    };
    body.appendChild(msg); body.appendChild(go1);
  }

  /** 送出：勾選的對帳結果＋略過／非客戶標記＋客戶資料學習，每批最多 30 筆 */
  function submitRows(btn, msgBox) {
    var rows = bs.rows, items = [], marks = [], learnBy = {};
    rows.filter(sendable).forEach(function (r) {
      var al = r.match.allocations;
      if (r.kind === 'TAX_PAYMENT') items.push({ txnKey: r.tx.key, txnSeq: r.tx.seq, txnDate: r.tx.dt, txnAmount: -r.tx.amount, rule: 'TAX_REF', allocations: [{ targetType: 'TAX_FILING', targetId: al[0].filingId, allocated: al[0].allocated, fee: 0 }] });
      else {
        items.push({ txnKey: r.tx.key, txnSeq: r.tx.seq, txnDate: r.tx.dt, txnAmount: r.tx.amount, rule: r.match.rule, allocations: al.map(function (a) { return { targetType: 'BILL', targetId: a.billId, allocated: a.allocated, fee: a.fee }; }) });
        if (r.learn !== false && (r.p.payerTag || r.p.payerAccount || r.p.payerName)) {
          // 一筆款分給多家公司時，帳號、戶名、標註對每一家都學（同帳號可對多家）
          al.forEach(function (a) {
            var k = a.companyId; learnBy[k] = learnBy[k] || { companyId: k, tag: '', accounts: [], names: [], fee: 0 };
            var L = learnBy[k]; if (r.p.payerTag && !L.tag) L.tag = r.p.payerTag;
            if (r.p.payerAccount && L.accounts.indexOf(r.p.payerAccount) < 0) L.accounts.push(r.p.payerAccount);
            if (r.p.payerName && L.names.indexOf(r.p.payerName) < 0) L.names.push(r.p.payerName);
            if (r.match.rule === 'B' && a.fee > 0 && !L.fee) L.fee = a.fee;
          });
        }
      }
    });
    rows.filter(function (r) { return r.mark && !r.done; }).forEach(function (r) { marks.push({ txnKey: r.tx.key, txnSeq: r.tx.seq, txnDate: r.tx.dt, mark: r.mark }); });
    var learn = Object.keys(learnBy).map(function (k) { return learnBy[k]; });
    if (!items.length && !marks.length) return;
    var summary = '即將送出 ' + items.length + ' 筆對帳結果' + (marks.length ? '、' + marks.length + ' 筆略過／非客戶標記' : '') + '。\n送出後請款單會依入帳金額更新（完全收齊＝已對帳、未收齊＝部分收款），若是代繳稅款也會標記「繳稅」。\n\n確定送出？';
    if (!confirm(summary)) return;
    btn.disabled = true;
    var batches = [], i;
    for (i = 0; i < items.length; i += 30) batches.push({ items: items.slice(i, i + 30), marks: [], learn: [] });
    if (batches.length) batches[batches.length - 1].learn = learn.slice(0, 60);
    for (i = 0; i < marks.length; i += 30) batches.push({ items: [], marks: marks.slice(i, i + 30), learn: [] });
    var okN = 0, failMsgs = [], n = 0;
    (function next() {
      if (n >= batches.length) {
        msgBox.textContent = '';
        reloadCtx(function () { alert('已寫入 ' + okN + ' 筆。' + (failMsgs.length ? '\n\n有 ' + failMsgs.length + ' 筆沒有寫入：\n' + failMsgs.slice(0, 5).join('\n') : '')); });
        return;
      }
      msgBox.textContent = '送出中（' + (n + 1) + '／' + batches.length + '）…';
      var b = batches[n++];
      call('bank.confirmMatches', { items: b.items, marks: b.marks, learn: b.learn }, function (res) {
        res.results.forEach(function (x) { if (x.ok) okN++; else failMsgs.push((x.message || x.code) + '（' + (x.txnKey || '').slice(0, 8) + '）'); });
        next();
      }, function (e) { failMsgs.push('這一批失敗：' + e.message); renderStmt(); alert('送出中斷：' + e.message + '\n已寫入 ' + okN + ' 筆；請重新選檔確認結果，已寫入的不會重複。'); });
    })();
  }

  /** 近期已確認（讓業主發現弄錯時取消） */
  function recentBox() {
    var det = el('details', { class: 'card', style: 'margin-top:10px' });
    det.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600' }, '近期已確認的銀行對帳結果（可取消確認）'));
    var body = el('div'); det.appendChild(body); var loaded = false;
    function load() {
      body.textContent = '載入中…';
      call('bank.listRecent', {}, function (d) {
        body.innerHTML = '';
        if (!d.matches.length) { body.appendChild(el('div', { class: 'muted' }, '還沒有已確認的銀行對帳結果。')); return; }
        var t = el('table', { class: 'auto' }), h = el('tr'); ['入帳日', '公司', '對象', '入帳', '匯費', '規則', '確認人', ''].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
        d.matches.forEach(function (m) {
          var tr = el('tr');
          [m.txnDate, m.companyId + ' ' + m.companyName, m.targetType === 'BILL' ? '請款單' : '營業稅申報列（繳稅）', money(m.allocated), m.fee ? String(m.fee) : '', RULE_LABEL[m.rule] || m.rule, m.confirmedBy].forEach(function (x) { tr.appendChild(el('td', {}, x)); });
          var td = el('td'), c = el('button', { class: 'linkbtn' }, '取消確認'); c.disabled = !d.canWrite;
          c.onclick = function () {
            if (!confirm('取消後，這筆入帳（若同一筆交易分配到多張請款單，一起取消）會從請款單扣回，請款單回到未收齊的狀態；該筆交易重新選檔時會再出現。確定取消？')) return;
            call('bank.cancelMatch', { matchId: m.matchId }, function () { load(); if (bs) reloadCtx(); });
          };
          td.appendChild(c); tr.appendChild(td); t.appendChild(tr);
        });
        body.appendChild(t);
      }, function (e) { body.textContent = e.message; });
    }
    det.addEventListener('toggle', function () { if (det.open && !loaded) { loaded = true; load(); } });
    return det;
  }

  /* ---------- 收款對帳（M2）：客戶資料。銀行交易明細不存雲端：只在瀏覽器記憶體讀取，不上傳 ---------- */
  var bankData = null;
  var XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  var xlsxPromise = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxPromise) xlsxPromise = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = XLSX_URL;
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { xlsxPromise = null; rej(new Error('無法載入 Excel 讀取元件，請檢查網路後再試')); };
      document.head.appendChild(s);
    });
    return xlsxPromise;
  }
  /** 讀一個台新明細 Excel：回傳 Promise<{ ok, message, txns, stats }>；檔案內容只留在記憶體 */
  function readBankFile(file) {
    return Promise.all([file.arrayBuffer(), loadXlsx()]).then(function (r) {
      var wb = r[1].read(new Uint8Array(r[0]), { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      return window.YcBank.readStatement(r[1].utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }));
    });
  }
  var ALIAS_TYPE_LABEL = { TAG: '網銀標註', NAME: '匯款戶名', ACCOUNT: '轉出帳號', FEE_HABIT: '慣例匯費' };
  var ALIAS_REP_ORDER = { TAG: 0, NAME: 1, ACCOUNT: 2, FEE_HABIT: 3 };   // 一家公司的「第一筆」代表：標註 → 戶名 → 帳號（慣例匯費不當代表）
  var aliasOpen = {}, aliasQ = '';

  function loadBank() {
    var box = $('bankBox'); box.textContent = '載入中…';
    call('bank.listAliases', {}, function (d) { bankData = d; renderBank(); }, function (e) { box.textContent = e.message; });
  }

  /** 客戶資料（原客戶資料）：一家公司一列，第一筆當代表，可展開看全部；欄位只有 統編、公司名稱、類型、內容 */
  function renderBank() {
    var d = bankData, box = $('bankBox'); box.innerHTML = '';
    var bar = el('div', { class: 'toolbar' });
    var search = el('input', { type: 'text', placeholder: '搜尋統編、公司名稱、標註、戶名、帳號' }); search.value = aliasQ;
    var add = el('button', { class: 'btn small' }, '新增客戶資料'); add.disabled = !d.canWrite; add.onclick = addCustomerDialog;
    bar.appendChild(search); bar.appendChild(add);
    if (d.isSuper) {
      var boot = el('button', { class: 'btn small secondary' }, '從銀行明細建立客戶資料'); boot.title = '上線前一次性：用歷史明細裡你打的網銀標註，一次建立客戶資料';
      boot.disabled = !d.canWrite; boot.onclick = bootstrapDialog; bar.appendChild(boot);
    }
    var ex = el('button', { class: 'btn small secondary' }, '全部展開'), co = el('button', { class: 'btn small secondary' }, '全部收合');
    bar.appendChild(ex); bar.appendChild(co);
    box.appendChild(bar);
    box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' }, '客戶資料＝「哪個網銀標註、戶名、轉出帳號屬於哪家公司」，對帳時用來自動認出付款人。同一個帳號可以對到多家公司（替多家公司付款）。每家公司以第一筆（標註優先）當代表，按右邊「共 N 筆」展開。'));
    if (!d.canWrite) box.appendChild(el('div', { class: 'alert' }, '唯讀模式：系統同步異常，暫時無法新增或修改。'));
    var tbl = el('div'); box.appendChild(tbl);
    // 依公司分組
    var by = {}, order = [];
    d.aliases.forEach(function (a) { if (!by[a.companyId]) { by[a.companyId] = { companyId: a.companyId, name: a.companyName, items: [] }; order.push(a.companyId); } by[a.companyId].items.push(a); });
    order.sort();
    order.forEach(function (id) { by[id].items.sort(function (x, y) { return (ALIAS_REP_ORDER[x.type] - ALIAS_REP_ORDER[y.type]) || x.value.localeCompare(y.value); }); });
    function valueText(a) { return a.type === 'FEE_HABIT' ? a.value + ' 元（對帳時這家平常被扣的匯費）' : a.value; }
    function actionsFor(a, td) {
      var ed = el('button', { class: 'linkbtn' }, '修改'); ed.disabled = !d.canWrite; ed.onclick = function () { aliasDialog(a); }; ed.style.marginRight = '14px';
      var del = el('button', { class: 'linkbtn', style: 'color:#b42318' }, '刪除'); del.disabled = !d.canWrite;
      del.onclick = function () {
        if (!confirm('刪除「' + ALIAS_TYPE_LABEL[a.type] + '：' + a.value + '」？\n刪除後無法復原（對帳時就不會再用它認付款人，已確認的對帳結果不受影響）。')) return;
        call('bank.deleteAlias', { aliasId: a.aliasId }, loadBank);
      };
      td.appendChild(ed); td.appendChild(del);
    }
    function paint() {
      tbl.innerHTML = '';
      var q = aliasQ.trim().toLowerCase();
      var list = order.map(function (id) { return by[id]; }).filter(function (g) {
        return !q || (g.companyId + ' ' + g.name + ' ' + g.items.map(function (a) { return a.value; }).join(' ')).toLowerCase().indexOf(q) >= 0;
      });
      if (!list.length) { tbl.appendChild(el('div', { class: 'muted' }, d.aliases.length ? '沒有符合的資料。' : '還沒有任何客戶資料。上線前可由超級管理員按「從銀行明細建立客戶資料」一次建立；之後對帳時會自動學習。')); return; }
      var t = el('table', { class: 'auto' }), h = el('tr');
      ['統編', '公司名稱', '類型', '內容', ''].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      list.forEach(function (g) {
        var rep = g.items.filter(function (a) { return a.type !== 'FEE_HABIT'; })[0] || g.items[0], tr = el('tr');
        tr.appendChild(el('td', { style: 'white-space:nowrap' }, g.companyId)); tr.appendChild(el('td', {}, g.name));
        tr.appendChild(el('td', { style: 'white-space:nowrap' }, ALIAS_TYPE_LABEL[rep.type]));
        var c = el('td', {}, valueText(rep)); if (rep.type === 'ACCOUNT' && rep.sameAccount > 1) c.appendChild(badge('同帳號 ' + rep.sameAccount + ' 家', 'warn'));
        tr.appendChild(c);
        var op = el('td', { style: 'white-space:nowrap' });
        if (g.items.length > 1) {
          var tg = el('button', { class: 'linkbtn' }, '共 ' + g.items.length + ' 筆 ' + (aliasOpen[g.companyId] ? '▲' : '▼'));
          tg.onclick = function () { aliasOpen[g.companyId] = !aliasOpen[g.companyId]; paint(); }; op.appendChild(tg);
        } else actionsFor(rep, op);
        tr.appendChild(op); t.appendChild(tr);
        if (g.items.length > 1 && aliasOpen[g.companyId]) {
          g.items.forEach(function (a) {
            var sr = el('tr', { style: 'background:#f6f8fb' });
            sr.appendChild(el('td', {}, '')); sr.appendChild(el('td', {}, ''));
            sr.appendChild(el('td', { style: 'white-space:nowrap' }, ALIAS_TYPE_LABEL[a.type]));
            var sc = el('td', {}, valueText(a)); if (a.type === 'ACCOUNT' && a.sameAccount > 1) sc.appendChild(badge('同帳號 ' + a.sameAccount + ' 家', 'warn'));
            sr.appendChild(sc);
            var so = el('td', { style: 'white-space:nowrap' }); actionsFor(a, so); sr.appendChild(so); t.appendChild(sr);
          });
        }
      });
      var sc2 = el('div', { class: 'scrollx' }); sc2.appendChild(t); tbl.appendChild(sc2);
      tbl.appendChild(el('div', { class: 'muted', style: 'margin-top:4px' }, '共 ' + list.length + ' 家公司'));
    }
    search.oninput = function () { aliasQ = search.value; paint(); };
    ex.onclick = function () { order.forEach(function (id) { aliasOpen[id] = true; }); paint(); };
    co.onclick = function () { aliasOpen = {}; paint(); };
    paint();
  }

  function companyOptions(sel, companies, withBlank) {
    if (withBlank) sel.appendChild(el('option', { value: '' }, withBlank));
    companies.forEach(function (c) { sel.appendChild(el('option', { value: c.id }, c.id + ' ' + (c.short || c.name))); });
  }

  /** 修改一筆客戶資料（類型不能改；可改公司與內容） */
  function aliasDialog(a) {
    var m = openModal('修改客戶資料');
    var comp = el('select'); companyOptions(comp, bankData.companies, '請選擇公司'); comp.value = a.companyId;
    var val = el('input', { type: a.type === 'FEE_HABIT' ? 'number' : 'text' }); val.value = a.value;
    field(m, '公司', comp); field(m, ALIAS_TYPE_LABEL[a.type], val);
    if (a.type === 'FEE_HABIT') m.appendChild(el('div', { class: 'muted' }, '慣例匯費＝這家客戶平常被銀行扣的匯費（元）。對帳時差額在這個金額內自動當匯費；超過會提醒您確認。系統會在您確認匯費時自動更新。'));
    var msg = el('div', { class: 'msg err' }), acts = el('div', { class: 'actions' });
    var cancel = el('button', { class: 'btn secondary' }, '取消'), ok = el('button', { class: 'btn' }, '儲存');
    cancel.onclick = closeModal;
    ok.onclick = function () {
      msg.textContent = '';
      if (!comp.value) { msg.textContent = '請選擇公司。'; return; }
      ok.disabled = true;
      call('bank.saveAlias', { aliasId: a.aliasId, companyId: comp.value, type: a.type, value: val.value }, function () { closeModal(); loadBank(); }, function (e) { ok.disabled = false; msg.textContent = e.message; });
    };
    acts.appendChild(cancel); acts.appendChild(ok); m.appendChild(msg); m.appendChild(acts);
  }

  /** 新增客戶資料：選一次公司，標註、戶名、帳號（可多個）一次填；沒填的不建立 */
  function addCustomerDialog() {
    var m = openModal('新增客戶資料');
    var comp = el('select'); companyOptions(comp, bankData.companies, '請選擇公司');
    var tag = el('input', { type: 'text', placeholder: '您在網銀打的簡稱，例如：磅空' });
    var nm = el('input', { type: 'text', placeholder: '銀行明細上的付款人名稱，例如：某某有限公司' });
    field(m, '公司', comp); field(m, '網銀標註', tag); field(m, '匯款戶名', nm);
    var accBox = el('div'), accs = [];
    function addAcc() { var i = el('input', { type: 'text', placeholder: '轉出帳號，例如：013-0000105035009741' }); i.style.marginBottom = '4px'; accs.push(i); accBox.appendChild(i); }
    addAcc();
    var f = el('div', { class: 'field' }); f.appendChild(el('label', {}, '轉出帳號（空白會自動去掉）')); f.appendChild(accBox);
    var more = el('button', { class: 'linkbtn' }, '＋ 再加一個帳號'); more.onclick = addAcc; f.appendChild(more); m.appendChild(f);
    var msg = el('div', { class: 'msg err' }), acts = el('div', { class: 'actions' });
    var cancel = el('button', { class: 'btn secondary' }, '取消'), ok = el('button', { class: 'btn' }, '新增');
    cancel.onclick = closeModal;
    ok.onclick = function () {
      msg.textContent = '';
      var accounts = accs.map(function (i) { return i.value.trim(); }).filter(Boolean);
      if (!comp.value) { msg.textContent = '請選擇公司。'; return; }
      if (!tag.value.trim() && !nm.value.trim() && !accounts.length) { msg.textContent = '標註、戶名、帳號至少填一項。'; return; }
      ok.disabled = true;
      call('bank.addAliases', { manual: true, items: [{ companyId: comp.value, tag: tag.value.trim(), names: nm.value.trim() ? [nm.value.trim()] : [], accounts: accounts }] }, function (r) {
        closeModal(); aliasOpen[comp.value] = true; loadBank();
        if (!r.added) alert('這些資料都已經存在，沒有新增。');
      }, function (e) { ok.disabled = false; msg.textContent = e.message; });
    };
    acts.appendChild(cancel); acts.appendChild(ok); m.appendChild(msg); m.appendChild(acts);
  }

  /** 建立客戶資料（M2 6.3，僅超管）：選歷史明細 → 瀏覽器只擷取「標註、帳號、戶名」組合（不讀金額與日期）→ 預覽 → 建立 */
  function bootstrapDialog() {
    var m = openModal('建立客戶資料'); $('modal').style.width = 'min(980px,96vw)';
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '請選擇已在網銀標註過的台新明細（建議最近 6～12 個月）。檔案只在這個頁面讀取，系統只會取出「標註、轉出帳號、匯款戶名」的不重複組合；金額與日期不會讀取、不會上傳。'));
    var file = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'hidden' });
    var dz = el('div', { class: 'card', style: 'border:2px dashed #98a2b3;text-align:center;padding:22px' });
    dz.appendChild(document.createTextNode('把台新明細 Excel 拖到這裡，或 '));
    var pickBtn = el('button', { class: 'btn small' }, '選擇檔案'); dz.appendChild(pickBtn); dz.appendChild(file);
    var info = el('div', { class: 'muted', style: 'margin:6px 0' }), body = el('div');
    m.appendChild(dz); m.appendChild(info); m.appendChild(body);
    var close = el('div', { class: 'actions' }), cl = el('button', { class: 'btn secondary' }, '關閉'); cl.onclick = closeModal; close.appendChild(cl); m.appendChild(close);
    wireDropZone(dz, file, pickBtn, /\.xlsx?$/i, false, function (files) {
      var f = files[0];
      body.innerHTML = ''; info.textContent = '讀取中…';
      readBankFile(f).then(function (r) {
        if (!r.ok) { info.textContent = ''; body.appendChild(el('div', { class: 'msg err' }, r.message)); return; }
        var combos = window.YcBank.customerCombos(r.txns);
        info.textContent = '共 ' + r.stats.rows + ' 筆交易，其中帶網銀標註的客戶收款有 ' + combos.reduce(function (s, c) { return s + c.count; }, 0) + ' 筆（' + combos.length + ' 組不重複的標註／帳號／戶名）。';
        if (!combos.length) { body.appendChild(el('div', { class: 'msg err' }, '這份明細沒有帶「未歸類 標註」的客戶收款，無法建立。')); return; }
        info.textContent += ' 正在比對公司…';
        call('bank.bootstrapPreview', { combos: combos }, function (pv) { info.textContent = info.textContent.replace(' 正在比對公司…', ''); renderBootstrap(body, pv); }, function (e) { info.textContent = ''; body.appendChild(el('div', { class: 'msg err' }, e.message)); });
      }, function (e) { info.textContent = ''; body.appendChild(el('div', { class: 'msg err' }, e.message || '讀取失敗')); });
    });
  }

  function renderBootstrap(body, pv) {
    body.innerHTML = '';
    var sel = {}; // tag → 'ACCEPT'（接受自動對上）／'SKIP'／公司編號
    function isAuto(g) { return g.status === 'AUTO' || g.status === 'COMBO'; }
    var auto = pv.groups.filter(isAuto), todo = pv.groups.filter(function (g) { return !isAuto(g); });
    var summary = el('div', { style: 'margin:8px 0;font-weight:600' });
    function value(g) { return sel[g.tag] === undefined ? (isAuto(g) ? 'ACCEPT' : '') : sel[g.tag]; }
    /** 這個標註要建立到哪些公司（一般是一家；標註含多家簡稱時是多家） */
    function companiesOf(g) { var v = value(g); return v === 'ACCEPT' ? g.candidates.map(function (c) { return c.companyId; }) : (v && v !== 'SKIP' ? [v] : []); }
    function companyOf(g) { return companiesOf(g).length ? 'x' : ''; }
    function paintSummary() {
      var n = pv.groups.filter(function (g) { return companyOf(g); }).length, skip = pv.groups.length - n, hot = pv.groups.filter(function (g) { return !companyOf(g) && g.suggest; }).length;
      summary.textContent = '將建立 ' + n + ' 個標註的對照；略過 ' + skip + ' 個' + (hot ? '（其中 ' + hot + ' 個出現過多次，建議確認是不是客戶）' : '') + '。';
    }
    function tableFor(list, title, choose) {
      if (!list.length) return;
      body.appendChild(el('h3', { style: 'margin:10px 0 4px' }, title));
      var t = el('table', { class: 'auto' }), h = el('tr');
      ['標註', '次數', '帳號／戶名', choose ? '對應公司' : '對到公司', ''].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
      list.forEach(function (g) {
        var tr = el('tr', g.suggest ? { style: 'background:#fff8e1' } : {});
        tr.appendChild(el('td', {}, g.tag)); tr.appendChild(el('td', {}, String(g.count)));
        tr.appendChild(el('td', { class: 'muted' }, (g.accounts.length ? g.accounts.length + ' 個帳號' : '無帳號') + (g.skippedAccounts ? '（另有 ' + g.skippedAccounts + ' 個只出現一次的不加入）' : '') + (g.names.length ? '、' + g.names.slice(0, 2).join('／') + (g.names.length > 2 ? '…' : '') : '')));
        var td = el('td'), td2 = el('td');
        if (!choose) {
          var cb = el('input', { type: 'checkbox' }); cb.checked = value(g) === 'ACCEPT';
          cb.onchange = function () { sel[g.tag] = cb.checked ? 'ACCEPT' : 'SKIP'; paintSummary(); };
          td.appendChild(document.createTextNode(g.candidates.map(function (c) { return c.companyId + ' ' + c.name; }).join('、') + (g.status === 'COMBO' ? '（標註含多家，一筆款分給這幾家）' : (g.how === 'prefix' ? '（開頭相符）' : ''))));
          td2.appendChild(cb); td2.appendChild(document.createTextNode(' 加入')); if (g.alreadyHas) td2.appendChild(badge('已有', 'off'));
        } else {
          var s = el('select');
          s.appendChild(el('option', { value: '' }, '略過（不建立）'));
          var cands = g.candidates.map(function (c) { return c.companyId; });
          if (g.candidates.length) { var og = el('optgroup', { label: '可能是' }); g.candidates.forEach(function (c) { og.appendChild(el('option', { value: c.companyId }, c.companyId + ' ' + c.name)); }); s.appendChild(og); }
          var og2 = el('optgroup', { label: '其他公司' });
          pv.companies.filter(function (c) { return cands.indexOf(c.id) < 0; }).forEach(function (c) { og2.appendChild(el('option', { value: c.id }, c.id + ' ' + c.name)); }); s.appendChild(og2);
          s.value = value(g);
          s.onchange = function () { sel[g.tag] = s.value; paintSummary(); };
          td.appendChild(s);
        }
        tr.appendChild(td); tr.appendChild(td2); t.appendChild(tr);
      });
      body.appendChild(t);
    }
    tableFor(auto, '自動對上（' + auto.length + '）— 勾選＝加入', false);
    tableFor(todo, '沒有自動對上（' + todo.length + '）— 選一家公司就建立，不選就略過；出現多次的標黃色，建議確認', true);
    body.appendChild(summary);
    var msg = el('div', { class: 'msg err' }), go1 = el('button', { class: 'btn' }, '建立');
    go1.disabled = !pv.canWrite;
    go1.onclick = function () {
      var items = [];
      pv.groups.forEach(function (g) { companiesOf(g).forEach(function (cid) { items.push({ companyId: cid, tag: g.tag, accounts: g.accounts, names: g.names }); }); });
      if (!items.length) { msg.textContent = '沒有可建立的項目。'; return; }
      go1.disabled = true; msg.textContent = '';
      call('bank.bootstrapApply', { items: items }, function (r) { closeModal(); loadBank(); alert('已建立：新增 ' + r.added + ' 筆客戶資料（已存在而略過 ' + r.skipped + ' 筆）。'); }, function (e) { go1.disabled = false; msg.textContent = e.message; });
    };
    body.appendChild(msg); body.appendChild(go1);
    paintSummary();
  }

  /* ---------- 通知設定（模組設定頁，僅超管） ---------- */
  function renderNoticeSettings() {
    var box = $('setNoticeBox'); box.innerHTML = '';
    call('tax.getNoticeSettings', {}, function (r) {
      var s = JSON.parse(JSON.stringify(r.settings)), c = el('div', { class: 'card' });
      c.appendChild(el('div', { class: 'card-title' }, '通知設定（發送清單用）'));
      if (!r.canWrite) c.appendChild(el('div', { class: 'alert' }, '系統同步異常，目前只能查看，不能儲存。'));
      function num(label, key, hint) {
        var i = el('input', { type: 'number', style: 'width:120px' }); i.value = s[key]; i.oninput = function () { s[key] = Number(i.value); };
        field(c, label, i, hint);
      }
      num('第一次通知日（每期幾日發）', 'notice1Day', '首頁「該發第一次通知」到這天才會有數字。');
      num('第二次通知日', 'notice2Day');
      num('第一次通知的發票截止日（幾日前）', 'invoiceDay1', '訊息裡的 {截止日}。');
      num('第二次通知的發票截止日', 'invoiceDay2');
      num('催款天數（請款通知後幾天沒回報匯款才催）', 'dunDays');
      var sw = el('input', { type: 'checkbox' }); sw.checked = !!s.lineSendEnabled; sw.onchange = function () { s.lineSendEnabled = sw.checked; };
      var swl = el('label', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px' }); swl.appendChild(sw); swl.appendChild(el('span', {}, '開啟 LINE 自動發送（關閉時，發送清單只能複製訊息；已排隊的訊息會保留、不會發出）'));
      c.appendChild(swl);
      var bn = el('textarea', { rows: '3', style: 'width:100%' }); bn.value = s.bankNote; bn.oninput = function () { s.bankNote = bn.value; };
      field(c, '匯款帳號說明（放進請款通知；留空則不顯示）', bn);
      var ph = r.placeholders.map(function (x) { return '{' + x + '}'; }).join(' ');
      [['tplNotice1', '第一次通知訊息（手動複製版）'], ['tplNotice2', '第二次通知訊息（手動複製版）'], ['tplBill', '請款通知訊息（手動複製版）'], ['tplDun', '催款訊息（手動複製版）'],
       ['tplLineNotice1', '第一次通知訊息（LINE 版，訊息下方有按鈕）'], ['tplLineNotice2', '第二次通知訊息（LINE 版）'], ['tplLineBill', '請款通知訊息（LINE 版）'], ['tplLineDun', '催款訊息（LINE 版）']].forEach(function (t) {
        var ta = el('textarea', { rows: '6', style: 'width:100%' }); ta.value = s[t[0]]; ta.oninput = function () { s[t[0]] = ta.value; };
        var reset = el('button', { class: 'linkbtn' }, '還原預設'); reset.onclick = function () { s[t[0]] = r.defaults[t[0]]; ta.value = s[t[0]]; };
        field(c, t[1], ta, '可用欄位：' + ph); c.lastChild.appendChild(reset);
      });
      var save = el('button', { class: 'btn' }, '儲存通知設定'); save.disabled = !r.canWrite;
      var out = el('span', { class: 'muted', style: 'margin-left:10px' });
      save.onclick = function () {
        save.disabled = true; out.textContent = '儲存中…';
        call('tax.saveNoticeSettings', s, function () { save.disabled = false; out.textContent = '已儲存'; }, function (e) { save.disabled = false; out.textContent = e.message; });
      };
      c.appendChild(save); c.appendChild(out); box.appendChild(c);
    }, function (e) { box.textContent = e.message; });
  }

  /* ---------- 申報書與繳稅回執自動讀取設定（稅務模組設定頁，僅超管）：起始期別；AI 開關與模型在「系統設定 → AI 設定」 ---------- */
  function renderDocSettings() {
    var box = $('setDocBox'); box.innerHTML = '';
    call('tax.getDocSettings', {}, function (r) {
      var c = el('div', { class: 'card' }), s = { startPeriod: r.startPeriod };
      c.appendChild(el('div', { class: 'card-title' }, '申報書與繳稅回執自動讀取'));
      if (!r.canWrite) c.appendChild(el('div', { class: 'alert' }, '系統同步異常，目前只能查看，不能儲存。'));
      c.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '系統會自動讀取客戶資料夾裡「營業稅申報書」與「繳稅證明／營業稅」的 PDF，填入申報日與繳稅日（人工填過的不會被蓋掉）。程式讀不出來的文件要不要請 AI 讀，到「系統設定 → AI 設定」開關。'));
      var sp = el('input', { type: 'text', style: 'width:160px' }); sp.value = s.startPeriod; sp.oninput = function () { s.startPeriod = sp.value.trim(); };
      field(c, '起始期別（早於這一期的文件完全不讀、不寫）', sp, '格式例如 VAT-115-09＝115 年 9–10 月；預設 ' + r.defaultStart + '。');
      var save = el('button', { class: 'btn' }, '儲存'); save.disabled = !r.canWrite;
      var out = el('span', { class: 'muted', style: 'margin-left:10px' });
      save.onclick = function () {
        save.disabled = true; out.textContent = '儲存中…';
        call('tax.saveDocSettings', s, function () { save.disabled = false; out.textContent = '已儲存'; }, function (e) { save.disabled = false; out.textContent = e.message; });
      };
      c.appendChild(save); c.appendChild(out); box.appendChild(c);
    }, function (e) { box.textContent = e.message; });
  }

  /* ---------- AI 設定（系統設定頁，僅超管）：全系統共用一把金鑰，每種用途各自開關與選模型 ---------- */
  function renderAiSettings() {
    var box = $('aiBox'); box.innerHTML = '載入中…';
    call('ai.getSettings', {}, function (r) {
      box.innerHTML = '';
      var c = el('div', { class: 'card' }), st = {};
      c.appendChild(el('div', { class: 'card-title' }, 'AI 設定'));
      if (!r.canWrite) c.appendChild(el('div', { class: 'alert' }, '系統同步異常，目前只能查看，不能儲存。'));
      c.appendChild(el('div', { class: r.keySet ? 'muted' : 'alert', style: 'margin-bottom:10px' },
        r.keySet ? 'Gemini 金鑰：已設定（全系統共用一把）。每種用途可以各自開關、各自選模型（可以選不同價位的模型來省錢）。開啟的用途才會把文件送到 Gemini。'
                 : 'Gemini 金鑰：尚未設定，所有用途即使打開開關也不會送出任何文件。金鑰要由維護人員在 Cloudflare 以 wrangler secret put GEMINI_API_KEY 放入（不會經過這個網頁）。'));
      var t = el('table'), hd = el('tr');
      ['用途', '開啟', '模型名稱'].forEach(function (x) { hd.appendChild(el('th', {}, x)); }); t.appendChild(hd);
      r.purposes.forEach(function (p) {
        st[p.key] = { enabled: p.enabled, model: p.model };
        var tr = el('tr', p.ready ? {} : { class: 'dim' });
        var n = el('td'); n.appendChild(el('div', { style: 'font-weight:600' }, p.label + (p.ready ? '' : '（功能尚未開發）'))); n.appendChild(el('div', { class: 'muted', style: 'font-size:12px;max-width:420px' }, p.note)); tr.appendChild(n);
        var e = el('td'), sw = el('input', { type: 'checkbox' }); sw.checked = p.enabled; sw.onchange = function () { st[p.key].enabled = sw.checked; }; e.appendChild(sw); tr.appendChild(e);
        var m = el('td'), mi = el('input', { type: 'text', style: 'width:240px' }); mi.value = p.model; mi.oninput = function () { st[p.key].model = mi.value.trim(); }; m.appendChild(mi); tr.appendChild(m);
        t.appendChild(tr);
      });
      c.appendChild(t);
      c.appendChild(el('div', { class: 'muted', style: 'margin:6px 0 10px' }, '模型名稱預設 ' + r.defaultModel + '；留空會回到預設。之後新增用途（例如發票辨識、銀行明細辨識）會自動多一列，不需要再改這個頁面。'));
      var save = el('button', { class: 'btn' }, '儲存 AI 設定'); save.disabled = !r.canWrite;
      var out = el('span', { class: 'muted', style: 'margin-left:10px' });
      save.onclick = function () {
        save.disabled = true; out.textContent = '儲存中…';
        call('ai.saveSettings', { purposes: st }, function () { save.disabled = false; out.textContent = '已儲存'; }, function (e2) { save.disabled = false; out.textContent = e2.message; });
      };
      c.appendChild(save); c.appendChild(out); box.appendChild(c);
    }, function (e) { box.textContent = e.message; });
  }

  /* ---------- 首頁區塊（P4）：期限列、異常、我的備忘、待辦卡片、整體進度、LINE 綁定進度 ---------- */
  var taxHomeData = null;
  function loadTaxHome(periodId) {
    call('tax.getHome', { periodId: periodId || undefined }, function (h) { taxHomeData = h; renderTaxHome(); },
      function (e) { $('taxHome').textContent = e.message; });
  }
  function countdown(n) { if (n == null) return ''; if (n > 0) return '還有 ' + n + ' 天'; if (n === 0) return '今天截止'; return '已逾期 ' + (-n) + ' 天'; }

  /** 「已看過」：全事務所共用；有更新的上傳才會再出現 */
  function markSeen(keys) {
    call('tax.markSeen', { keys: keys }, function () { loadTax(taxData && taxData.period && taxData.period.periodId); }, function (e) { alert(e.message); });
  }

  function renderTaxHome() {
    var h = taxHomeData, box = $('taxHome'); box.innerHTML = '';
    if (!h || !h.period) return;
    var d = h.deadlines;

    var bar = el('div', { class: 'card', style: 'display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:10px' });
    bar.appendChild(el('strong', {}, h.period.label));
    var c1 = el('span', {}, '申報期限 ' + d.deadline + '　'), t1 = el('strong', { style: d.daysToDeadline != null && d.daysToDeadline < 0 ? 'color:var(--danger)' : '' }, countdown(d.daysToDeadline)); c1.appendChild(t1);
    var c2 = el('span', { class: 'muted' }, '繳稅期限 ' + d.payDeadline + '　' + countdown(d.daysToPayDeadline));
    bar.appendChild(c1); bar.appendChild(c2); box.appendChild(bar);

    if (h.anomalies.length) {
      var an = el('div', { style: 'background:#fde2e2;border:1px solid #f4b4b4;border-radius:8px;padding:10px 14px;margin-bottom:10px' });
      an.appendChild(el('div', { style: 'font-weight:700;color:var(--danger);margin-bottom:6px' }, '異常（' + h.anomalies.length + ' 項）'));
      h.anomalies.forEach(function (x) {
        var det = el('details', { style: 'margin:4px 0' });
        det.appendChild(el('summary', { style: 'cursor:pointer;color:var(--danger)' }, (x.severity === 'high' ? '嚴重｜' : '') + x.label + '：' + x.items.length + ' ' + (x.unit || '家')));
        x.items.forEach(function (it) {
          var line = el('div', { style: 'padding:2px 0 2px 18px;font-size:13px' }, it.name + '　' + it.companyId + (it.note ? '　（' + it.note + '）' : ''));
          if (it.goAdvance) { var gb = el('button', { class: 'linkbtn', style: 'margin-left:8px' }, '到代墊帳款'); gb.onclick = function () { advPreset = it.companyId; bankTab = 'advance'; go('bank'); }; line.appendChild(gb); }
          if (it.seenKey) { var sb = el('button', { class: 'linkbtn', style: 'margin-left:8px' }, '已看過'); sb.onclick = function () { markSeen([it.seenKey]); }; line.appendChild(sb); }
          det.appendChild(line);
        });
        an.appendChild(det);
      });
      box.appendChild(an);
    }

    var nw = h.news || { moreInvoices: [], afterFiled: [], excluded: [] };
    if (nw.moreInvoices.length || nw.afterFiled.length || nw.excluded.length) {
      var nb = el('div', { style: 'background:#e8f1fd;border:1px solid #a9c8f2;border-radius:8px;padding:10px 14px;margin-bottom:10px' });
      nb.appendChild(el('div', { style: 'font-weight:700;color:#1f4f99;margin-bottom:6px' }, '新動態'));
      function group(title, list, extra) {
        if (!list.length) return;
        var det = el('details', { style: 'margin:4px 0' });
        det.appendChild(el('summary', { style: 'cursor:pointer;color:#1f4f99' }, title + '：' + list.length + ' 家'));
        list.forEach(function (it) {
          var line = el('div', { style: 'padding:2px 0 2px 18px;font-size:13px' }, it.name + '　' + it.companyId + '　又收到 ' + it.count + ' 份（最近 ' + it.lastDay + '）');
          var sb = el('button', { class: 'linkbtn', style: 'margin-left:8px' }, '已看過'); sb.onclick = function () { markSeen([it.seenKey]); }; line.appendChild(sb);
          if (extra) line.appendChild(extra(it));
          det.appendChild(line);
        });
        var all = el('button', { class: 'linkbtn', style: 'margin:2px 0 4px 18px' }, '全部已看過'); all.onclick = function () { markSeen(list.map(function (x) { return x.seenKey; })); };
        det.appendChild(all); nb.appendChild(det);
      }
      group('客戶又傳了發票（還沒出請款單）', nw.moreInvoices);
      group('申報後又收到的檔案（可能屬於下一期）', nw.afterFiled);
      group('非營業稅申報客戶有新動態', nw.excluded, function (it) {
        var ab = el('button', { class: 'linkbtn', style: 'margin-left:8px' }, '加回營業稅申報客戶');
        ab.onclick = function () { call('tax.setVatExcluded', { companyIds: [it.companyId], excluded: false }, function () { loadTax(taxData && taxData.period && taxData.period.periodId); }, function (e) { alert(e.message); }); };
        return ab;
      });
      box.appendChild(nb);
    }
    box.appendChild(renderMemoBox(h));
    if (scrollToMemo) { scrollToMemo = false; var mb0 = $('taxMemoBox'); if (mb0) mb0.scrollIntoView(); }

    var grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:10px' });
    h.cards.forEach(function (c) {
      var card = el('button', { class: 'card', style: 'text-align:left;cursor:pointer;margin:0;' + (c.count ? '' : 'opacity:.6') });
      card.appendChild(el('div', { style: 'font-size:24px;font-weight:700' }, String(c.count)));
      card.appendChild(el('div', { style: 'font-weight:600' }, c.label));
      card.appendChild(el('div', { class: 'muted', style: 'font-size:12px' }, c.hint));
      card.onclick = function () {
        if (c.key === 'reconDiff') { openLedger('ALL', 'diff'); return; }            // 收款對帳：跨期，直接帶篩選
        if (c.key === 'reportedLate') { openLedger('ALL', 'reportedLate'); return; }
        if (CARD_NOTICE[c.key]) { if (taxData && taxData.period) noticeDialog(CARD_NOTICE[c.key]); return; } // 通知類卡片：直接開發送清單（沒有該發的也能開，可看已發過的）
        if (!c.count) return;
        taxAFocus = { label: c.label, ids: c.filingIds }; taxView = 'A';
        try { localStorage.setItem('taxView', 'A'); } catch (e) { /* 略過 */ }
        if (taxData) { renderTaxTable(); $('taxBox').scrollIntoView(); }
      };
      grid.appendChild(card);
    });
    box.appendChild(grid);

    var pg = el('div', { class: 'card', style: 'margin-bottom:10px' });
    pg.appendChild(el('div', { class: 'card-title' }, '整體進度（' + h.progress.total + ' 家）'));
    h.progress.stages.forEach(function (st) {
      var pct = h.progress.total ? Math.round(st.done * 100 / h.progress.total) : 0;
      var line = el('div', { style: 'display:flex;align-items:center;gap:8px;padding:2px 0;font-size:13px' });
      line.appendChild(el('span', { style: 'width:84px' }, st.label));
      var track = el('div', { style: 'flex:1;height:10px;background:#eef1f5;border-radius:5px;overflow:hidden' });
      track.appendChild(el('div', { style: 'height:100%;width:' + pct + '%;background:#7aa7d9' })); line.appendChild(track);
      line.appendChild(el('span', { style: 'width:90px;text-align:right', class: 'muted' }, st.done + ' / ' + h.progress.total + '（' + pct + '%）'));
      pg.appendChild(line);
    });
    box.appendChild(pg);

    if (h.line) {
      var ln = el('div', { class: 'card', style: 'margin-bottom:10px' });
      ln.appendChild(el('div', { class: 'card-title' }, 'LINE 綁定進度'));
      var pct2 = h.line.total ? Math.round(h.line.bound * 100 / h.line.total) : 0;
      ln.appendChild(el('div', {}, '已綁定 ' + h.line.bound + ' / 共 ' + h.line.total + ' 家（' + pct2 + '%）' + (h.line.pending ? '　申請中 ' + h.line.pending + ' 家' : '')));
      var tr2 = el('div', { style: 'height:10px;background:#eef1f5;border-radius:5px;overflow:hidden;margin:6px 0' }); tr2.appendChild(el('div', { style: 'height:100%;width:' + pct2 + '%;background:#06C755' })); ln.appendChild(tr2);
      if (h.line.unbound.length) {
        var bl = el('button', { class: 'btn small secondary' }, '看未綁定名單');
        bl.onclick = function () {
          var m = openModal('未綁定 LINE 的客戶（' + h.line.unbound.length + ' 家）');
          var wrap = el('div', { style: 'max-height:55vh;overflow:auto' });
          h.line.unbound.forEach(function (u) { wrap.appendChild(el('div', { style: 'padding:3px 0;border-top:1px solid var(--line)' }, u.name + '　' + u.companyId + (u.pending ? '　（申請中）' : ''))); });
          m.appendChild(wrap);
          var bar2 = el('div', { class: 'actions' }), cl = el('button', { class: 'btn secondary' }, '關閉'); cl.onclick = closeModal; bar2.appendChild(cl); m.appendChild(bar2);
        };
        ln.appendChild(bl);
      }
      box.appendChild(ln);
    }
  }

  function renderMemoBox(h) {
    var box = el('div', { style: 'background:#fff7d6;border:1px solid #ecd987;border-radius:8px;padding:10px 14px;margin-bottom:10px' });
    var open = h.memos.filter(function (m) { return !m.done; }).length;
    box.appendChild(el('div', { style: 'font-weight:700;color:#8a6d00;margin-bottom:6px' }, '我的備忘（' + open + ' 則待辦）'));
    box.id = 'taxMemoBox';
    function save(args) { call('tax.saveMemo', args, function () { loadTaxHome(taxData && taxData.period && taxData.period.periodId); refreshMemoBadge(); }, function (e) { alert(e.message); }); }
    function postpone(m) {
      var md = openModal('延後備忘');
      md.appendChild(el('div', { style: 'margin-bottom:8px' }, m.text));
      var di = el('input', { type: 'date' }), t = new Date(Date.now() + 86400000), p2 = function (n) { return ('0' + n).slice(-2); };
      di.value = t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate()); field(md, '延後到', di);
      modalActions(md, '儲存', function (fail) { if (!di.value) return fail('請選日期'); call('tax.saveMemo', { memoId: m.memoId, dueDate: di.value }, function () { closeModal(); loadTaxHome(taxData && taxData.period && taxData.period.periodId); refreshMemoBadge(); }, function (e) { fail(e.message); }); });
    }
    var shown = h.memos.filter(function (m) { return !m.done; }), folded = shown.length > 5, doneList = h.memos.filter(function (m) { return m.done; });
    var list = shown.slice(0, 5), rest = shown.slice(5).concat(doneList);
    if (!folded) list = shown.concat(doneList), rest = [];
    function addLine(m, parent) {
      var line = el('div', { style: 'display:flex;align-items:center;gap:8px;padding:3px 0' });
      var cb = el('input', { type: 'checkbox' }); cb.checked = m.done; cb.onchange = function () { save({ memoId: m.memoId, done: cb.checked }); };
      var late = !m.done && m.dueDate && m.dueDate <= h.today;
      var tx = el('span', { style: 'flex:1;' + (m.done ? 'text-decoration:line-through;color:#8a8a8a' : (late ? 'font-weight:700;color:var(--danger)' : '')) }, m.text + (m.dueDate ? '　（' + m.dueDate + '）' : ''));
      var del = el('button', { class: 'linkbtn', title: '刪除' }, '✕'); del.onclick = function () { if (confirm('刪除這則備忘？')) save({ memoId: m.memoId, remove: true }); };
      line.appendChild(cb); line.appendChild(tx);
      if (!m.done) { var pp = el('button', { class: 'linkbtn', title: '延後' }, '延後'); pp.onclick = function () { postpone(m); }; line.appendChild(pp); }
      line.appendChild(del); parent.appendChild(line);
    }
    list.forEach(function (m) { addLine(m, box); });
    if (rest.length) {
      var more = el('details', { style: 'margin-top:4px' });
      more.appendChild(el('summary', { style: 'cursor:pointer;color:#8a6d00' }, '還有 ' + rest.length + ' 則'));
      rest.forEach(function (m) { addLine(m, more); }); box.appendChild(more);
    }
    var add = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' });
    var ti = el('input', { type: 'text', maxlength: '200', placeholder: '新增備忘…（不綁客戶，只有您看得到）', style: 'flex:1;min-width:200px' });
    var di = el('input', { type: 'date', style: 'width:auto' });
    var ab = el('button', { class: 'btn small' }, '新增');
    ab.onclick = function () { if (!ti.value.trim()) return alert('請輸入備忘內容'); save({ text: ti.value, dueDate: di.value || '' }); };
    ti.addEventListener('keydown', function (e) { if (e.key === 'Enter') ab.click(); });
    add.appendChild(ti); add.appendChild(di); add.appendChild(ab); box.appendChild(add);
    return box;
  }

  function renderTaxTable() {
    var d = taxData, box = $('taxBox'); box.innerHTML = '';
    $('taxViewA').className = 'btn small' + (taxView === 'A' ? '' : ' secondary'); $('taxViewB').className = 'btn small' + (taxView === 'B' ? '' : ' secondary');
    renderExcluded();
    if (d.period && taxView === 'A') { renderTaxA(taxVisibleRows(), box); updateTaxBatch(); return; }
    if (!d.period) { box.textContent = d.caps.isSuper ? '請按「開啟新期別」（每個單數月 1 號系統也會自動開啟）。' : '尚未開啟任何期別，請聯絡超級管理員。'; updateTaxBatch(); return; }
    var rows = taxVisibleRows();
    var t = el('table', { style: 'min-width:1050px' }), cg = el('colgroup'); box.style.overflowX = 'auto';
    ['34px', '95px', '130px', '90px'].concat(d.steps.map(function () { return '84px'; })).forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
    var h = el('tr'), all = el('input', { type: 'checkbox' });
    all.onchange = function () { rows.forEach(function (r) { if (r.applicable) { if (all.checked) taxSel[r.filingId] = 1; else delete taxSel[r.filingId]; } }); renderTaxTable(); };
    var th0 = el('th'); th0.appendChild(all); h.appendChild(th0);
    ['統一編號', '簡稱', '進度'].concat(d.steps.map(function (c) { return STEP_LABELS[c]; })).forEach(function (x) { h.appendChild(el('th', {}, x)); });
    t.appendChild(h);
    rows.forEach(function (r) {
      var tr = el('tr', r.applicable ? {} : { style: 'opacity:.55' });
      var c0 = el('td'), cb = el('input', { type: 'checkbox' }); cb.checked = !!taxSel[r.filingId]; cb.disabled = !r.applicable;
      cb.onchange = function () { if (cb.checked) taxSel[r.filingId] = 1; else delete taxSel[r.filingId]; updateTaxBatch(); };
      c0.appendChild(cb); tr.appendChild(c0);
      tr.appendChild(el('td', {}, r.companyId));
      var nm = el('td', { title: r.companyName }), nl = el('button', { class: 'linkbtn', style: 'text-decoration:none;color:inherit', title: '點一下查看客戶本期資料（備註、先代墊）' }, r.shortName || r.companyName);
      nl.onclick = function () { notesDialog(r); }; nm.appendChild(nl);
      if (r.invoices && r.invoices.newCount > 0) { var mb = el('button', { class: 'badge warn', style: 'margin-left:6px;border:0;cursor:pointer', title: '客戶又傳了檔案，按一下標示已看過' }, '又收到 ' + r.invoices.newCount + ' 份 ' + r.invoices.newLastAt.slice(5, 10)); mb.onclick = function () { markSeen(['F:' + r.filingId]); }; nm.appendChild(mb); }
      if (r.reports && r.reports.INVOICES_DONE) nm.appendChild(el('span', { class: 'badge ok', style: 'margin-left:6px', title: '客戶在 LINE 按了「我已傳完發票」' }, '✓客戶已確認傳完 ' + r.reports.INVOICES_DONE.slice(5)));
      if (r.reports && r.reports.NO_INVOICE) nm.appendChild(el('span', { class: 'badge warn', style: 'margin-left:6px', title: '客戶在 LINE 按了「本期沒有發票」' }, '客戶回覆本期沒有發票 ' + r.reports.NO_INVOICE.slice(5)));
      if (r.docs && (r.docs.filed || r.docs.paid)) { var dl = docLines(r), dif = (r.docs.filed && r.docs.filed.differs) || (r.docs.paid && r.docs.paid.differs); nm.appendChild(el('span', { class: 'badge ' + (dif ? 'warn' : 'ok'), style: 'margin-left:6px', title: dl.join('\n') }, dif ? '📄日期不同' : '📄已讀取')); }
      if (r.advance && (r.advance.status === 'OPEN' || r.advance.status === 'PARTIAL')) { var ab = el('span', { class: 'badge warn', style: 'margin-left:6px', title: '代墊日 ' + r.advance.advancedAt + (r.advance.recovered ? '，已收回 ' + money(r.advance.recovered) : '') }, '先代墊 ' + money(r.advance.remaining) + (r.advance.status === 'PARTIAL' ? '（部分收回）' : '（未收回）')); nm.appendChild(ab); }
      if (r.note || r.taxNotes || r.bookkeepingNotes) { var ni = el('button', { class: 'linkbtn', style: 'text-decoration:none;margin-left:4px', title: [r.note, r.taxNotes, r.bookkeepingNotes].filter(Boolean).join('\n') }, 'ⓘ'); ni.onclick = function () { notesDialog(r); }; nm.appendChild(ni); }
      tr.appendChild(nm);
      var last = lastStep(r, d.steps);
      var pg = el('td'); pg.appendChild(r.applicable ? badge(last ? STEP_LABELS[last] : '未開始', last === 'FILED' ? 'ok' : (last ? '' : 'off')) : badge('不適用', 'off')); tr.appendChild(pg);
      d.steps.forEach(function (code) {
        var td = el('td'), s = r.steps[code];
        var btn = el('button', { class: 'linkbtn', style: 'text-decoration:none' }, s && s.status === 'DONE' ? ('✔ ' + s.date.slice(5)) : '—');
        if (s && s.status === 'DONE') { btn.title = (s.by || '') + (s.source === 'LINE' ? '（依客戶 LINE 傳來的資料自動標記）' : '') + (s.source === 'DOC' ? '（依申報書／繳稅回執自動填入）' : '') + (s.source === 'DOC_AI' ? '（AI 讀取申報書／繳稅回執後自動填入，請抽查）' : '') + '（點一下修改日期或清除）'; btn.style.color = 'var(--ok)'; } else btn.style.color = '#98a2b3';
        btn.disabled = !r.applicable || d.period.status !== 'OPEN' || !d.caps.canWrite;
        btn.onclick = function () {
          if (s && s.status === 'DONE') stepDialog(r, code, s);
          else taxMark([r.filingId], code, 'DONE', todayStr());
        };
        td.appendChild(btn); tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    if (!rows.length) box.appendChild(el('div', { class: 'muted' }, d.rows.length ? '沒有符合條件的公司。' : '這個期別目前沒有任何公司。'));
    box.appendChild(t);
    updateTaxBatch();
  }

  function updateTaxBatch() {
    var n = Object.keys(taxSel).length, bar = $('taxBatch');
    bar.classList.toggle('hidden', !taxData || !taxData.period || taxData.period.status !== 'OPEN' || !taxData.caps.canWrite || taxView !== 'B');
    $('taxSelCount').textContent = '已選 ' + n + ' 家';
    ['taxMarkBtn', 'taxClearBtn', 'taxNaBtn', 'taxExclBtn'].forEach(function (id) { $(id).disabled = !n || taxBusy; });
  }

  /** 申報書與繳稅回執的讀取摘要（P6）：每列一句；與目前登記的日期不同時加註 */
  function docLines(r) {
    var out = [], d = r.docs; if (!d) return out;
    function md(x) { return x ? x.slice(5).replace('-', '/') : ''; }
    function money(n) { return n === null || n === undefined ? '' : Number(n).toLocaleString('en-US'); }
    if (d.filed) out.push('申報書' + (d.filed.ai ? '（AI 讀取）' : '') + '：' + md(d.filed.date) + ' 申報' + (d.filed.taxDue !== null ? '，應實繳 ' + money(d.filed.taxDue) : '') + (d.filed.count > 1 ? '（第 ' + d.filed.count + ' 次申報）' : '') + (d.filed.differs ? '　⚠與目前登記的 ' + md(d.filed.registered) + ' 不同' : ''));
    if (d.paid) out.push('繳稅回執' + (d.paid.ai ? '（AI 讀取）' : '') + '：' + md(d.paid.date) + ' 繳款 ' + money(d.paid.amount) + (d.paid.differs ? '　⚠與目前登記的 ' + md(d.paid.registered) + ' 不同' : ''));
    return out;
  }

  /** 標記步驟：畫面先更新，背景寫入；失敗或衝突時復原並重新載入 */
  function taxMark(ids, step, mode, date) {
    var d = taxData, undo = [], items = [];
    ids.forEach(function (id) {
      var r = taxRow(id); if (!r) return;
      items.push({ filingId: id, updatedAt: r.updatedAt });
      undo.push({ r: r, prev: r.steps[step] ? Object.assign({}, r.steps[step]) : null });
      r.steps[step] = { status: mode === 'DONE' ? 'DONE' : 'CLEARED', date: date, by: (me && me.name) || '', source: 'MANUAL' };
    });
    renderTaxTable();
    taxBusy = true; updateTaxBatch();
    call('tax.markSteps', { items: items, step: step, mode: mode, date: date || undefined }, function (res) {
      taxBusy = false;
      var bad = [];
      res.results.forEach(function (x) {
        var r = taxRow(x.filingId); if (!r) return;
        if (x.ok) { if (x.updatedAt) r.updatedAt = x.updatedAt; if (x.step) r.steps[step] = { status: x.step.status, date: x.step.date, by: x.step.by, source: 'MANUAL' }; }
        else { bad.push(x); var u = undo.filter(function (z) { return z.r === r; })[0]; if (u) { if (u.prev) r.steps[step] = u.prev; else delete r.steps[step]; } }
      });
      taxSel = {};
      renderTaxTable();
      loadTaxHome(d.period.periodId);
      if (bad.length) {
        var conflict = bad.some(function (x) { return x.code === 'CONFLICT'; });
        alert(bad.length + ' 家沒有完成：' + bad[0].message + (conflict ? '\n（畫面將重新載入）' : ''));
        if (conflict) loadTax(d.period.periodId);
      }
    }, function (err) {
      taxBusy = false;
      undo.forEach(function (u) { if (u.prev) u.r.steps[step] = u.prev; else delete u.r.steps[step]; });
      renderTaxTable(); alert(err.message);
    });
  }

  $('taxSearch').addEventListener('input', function () { if (taxData) renderTaxTable(); });
  $('taxFilter').addEventListener('change', function () { if (taxData) renderTaxTable(); });
  (function () { var f = $('taxFilter'); TAX_FILTERS.forEach(function (x) { f.appendChild(el('option', { value: x[0] }, x[1])); }); })();
  $('taxMarkBtn').onclick = function () { var step = $('taxStepSel').value, date = $('taxDate').value || todayStr(); taxMark(Object.keys(taxSel), step, 'DONE', date); };
  $('taxClearBtn').onclick = function () { var step = $('taxStepSel').value; if (confirm('取消已選 ' + Object.keys(taxSel).length + ' 家的「' + STEP_LABELS[step] + '」標記？')) taxMark(Object.keys(taxSel), step, 'CLEAR', ''); };
  $('taxNaBtn').onclick = function () {
    var ids = Object.keys(taxSel); if (!confirm('把已選 ' + ids.length + ' 家標為「不適用」（相當於 Excel 的 NA；可在篩選「不適用」中恢復）？')) return;
    taxBusy = true; updateTaxBatch();
    var i = 0;
    (function next() {
      if (i >= ids.length) { taxBusy = false; return loadTax(taxData.period.periodId); }
      var r = taxRow(ids[i++]);
      call('tax.setApplicable', { filingId: r.filingId, updatedAt: r.updatedAt, applicable: false }, next, function (e) { taxBusy = false; alert(e.message); loadTax(taxData.period.periodId); });
    })();
  };
  $('taxExclBtn').onclick = function () {
    var ids = Object.keys(taxSel).map(function (id) { return taxRow(id).companyId; });
    if (!confirm('把已選 ' + ids.length + ' 家設為「非營業稅申報」？' + String.fromCharCode(10) + '它們會從營業稅看板消失、之後的新期別也不再帶入，但所有資料都會保留；隨時可在畫面下方「非營業稅申報客戶」加回。')) return;
    taxBusy = true; updateTaxBatch();
    call('tax.setVatExcluded', { companyIds: ids, excluded: true }, function () { taxBusy = false; loadTax(taxData.period.periodId); }, function (e) { taxBusy = false; updateTaxBatch(); alert(e.message); });
  };
  function setTaxView(v) { taxView = v; try { localStorage.setItem('taxView', v); } catch (e) { /* 略過 */ } if (taxData) renderTaxTable(); }
  $('taxViewA').onclick = function () { setTaxView('A'); };
  $('taxViewB').onclick = function () { setTaxView('B'); };
  $('taxAddBtn').onclick = function () {
    if (!taxData || !taxData.period) return alert('請先開啟期別。');
    var m = openModal('加入公司到本期'); var box = el('div', { class: 'muted' }, '載入中…'); m.appendChild(box);
    call('tax.listProfiles', {}, function (pd) {
      box.remove();
      var inPeriod = {}; taxData.rows.forEach(function (r) { inPeriod[r.companyId] = 1; });
      var sel = el('select'); pd.profiles.filter(function (p) { return !inPeriod[p.companyId]; }).forEach(function (p) { sel.appendChild(el('option', { value: p.companyId }, p.companyId + ' ' + (p.shortName || p.companyName))); });
      field(m, '公司（尚未在本期清單中）', sel);
      modalActions(m, '加入', function (fail) { call('tax.addFiling', { periodId: taxData.period.periodId, companyId: sel.value }, function () { closeModal(); loadTax(taxData.period.periodId); }, function (e) { fail(e.message); }); });
    }, function (e) { box.textContent = e.message; });
  };

  /** 備註與注意事項：唯讀顯示申報／帳務注意事項，本期備註可直接編輯 */
  function notesDialog(r) {
    var m = openModal((r.shortName || r.companyName) + '　客戶本期資料');
    m.appendChild(el('div', { class: 'card-title' }, '申報注意事項')); m.appendChild(el('div', { style: 'white-space:pre-wrap;margin-bottom:12px' }, r.taxNotes || '（無）'));
    m.appendChild(el('div', { class: 'card-title' }, '帳務注意事項')); m.appendChild(el('div', { style: 'white-space:pre-wrap;margin-bottom:12px' }, r.bookkeepingNotes || '（無）'));
    advanceBlock(m, r);
    var inp = el('input', { type: 'text', maxlength: '300' }); inp.value = r.note || '';
    var canEdit = taxData.period.status === 'OPEN' && taxData.caps.canWrite; inp.disabled = !canEdit;
    field(m, '本期備註', inp);
    if (!canEdit) { var c = el('div', { class: 'actions' }), cb = el('button', { class: 'btn secondary' }, '關閉'); cb.onclick = closeModal; c.appendChild(cb); m.appendChild(c); return; }
    modalActions(m, '儲存', function (fail) {
      call('tax.setNote', { filingId: r.filingId, updatedAt: r.updatedAt, note: inp.value }, function (x) { r.note = inp.value.trim(); r.updatedAt = x.updatedAt; closeModal(); renderTaxTable(); }, function (e) { fail(e.message); if (e.code === 'CONFLICT') loadTax(taxData.period.periodId); });
    });
  }

  /** 已完成階段：改日期或清除（系統自動帶入的階段清除前再確認一次） */
  function stepDialog(r, code, s) {
    var name = r.shortName || r.companyId;
    var m = openModal(name + '　' + STEP_LABELS[code]);
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '操作人：' + (s.by || '') + (s.source && s.source !== 'MANUAL' ? '（系統自動記錄）' : '')));
    var dt = el('input', { type: 'date' }); dt.value = s.date || todayStr(); field(m, '日期', dt);
    var docPart = r.docs && (code === 'FILED' ? r.docs.filed : code === 'TAX_PAID' ? r.docs.paid : null);
    if (docPart && docPart.date) {
      var dbox = el('div', { class: docPart.differs ? 'alert' : 'muted', style: 'margin:6px 0' }, (code === 'FILED' ? '申報書' : '繳稅回執') + '上的日期是 ' + docPart.date + (docPart.differs ? '，與目前登記的不同（系統不會自動改人工填的日期）。' : '。'));
      if (docPart.differs) { var useDoc = el('button', { class: 'linkbtn', style: 'margin-left:8px' }, '改成文件上的日期'); useDoc.onclick = function () { dt.value = docPart.date; }; dbox.appendChild(useDoc); }
      m.appendChild(dbox);
    }
    var bar = el('div', { class: 'actions' });
    var bs = el('button', { class: 'btn' }, '儲存日期'), bc = el('button', { class: 'btn danger' }, '清除標記'), bx = el('button', { class: 'btn secondary' }, '關閉');
    var ok = taxData.period.status === 'OPEN' && taxData.caps.canWrite; bs.disabled = !ok; bc.disabled = !ok;
    bs.onclick = function () { if (!dt.value) return; closeModal(); taxMark([r.filingId], code, 'DONE', dt.value); };
    bc.onclick = function () {
      var auto = s.source && s.source !== 'MANUAL';
      if (auto && !confirm('這是系統自動記錄的階段，確定要清除嗎？')) return;
      closeModal(); taxMark([r.filingId], code, 'CLEAR', '');
    };
    bx.onclick = closeModal; bar.appendChild(bs); bar.appendChild(bc); bar.appendChild(bx); m.appendChild(bar);
  }

  function openPeriodDialog() {
    var m = openModal('開啟新期別（營業稅）');
    var now = new Date(), roc = now.getFullYear() - 1911, mon = now.getMonth() + 1;
    var year = el('input', { type: 'text' }); year.value = String(roc);
    var month = el('select'); [1, 3, 5, 7, 9, 11].forEach(function (x) { var o = el('option', { value: String(x) }, x + '–' + (x + 1) + ' 月'); if (x === (mon % 2 ? mon : mon - 1)) o.selected = true; month.appendChild(o); });
    var dl = el('input', { type: 'text', placeholder: '留空＝預設（次期 15 日）；格式 2026-11-15' });
    field(m, '民國年', year); field(m, '期別', month); field(m, '申報期限（遇假日可手動順延，之後也能修改）', dl);
    m.appendChild(el('div', { class: 'muted' }, '開啟時，系統會替所有「營業稅客戶＝是」的有效公司各建立一列。'));
    modalActions(m, '開啟', function (fail) {
      call('tax.openPeriod', { taxType: 'VAT', rocYear: Number(year.value), startMonth: Number(month.value), deadline: dl.value.trim() || undefined }, function (r) {
        closeModal(); alert('已開啟「' + r.label + '」，共 ' + r.filings + ' 家公司。'); loadTax(r.periodId);
      }, function (e) { fail(e.message); });
    });
  }
  function deadlineDialog() {
    var m = openModal('修改申報期限：' + taxData.period.label);
    var inp = el('input', { type: 'text' }); inp.value = taxData.period.deadline;
    field(m, '申報期限（格式 2026-11-15）', inp);
    modalActions(m, '儲存', function (fail) { call('tax.setDeadline', { periodId: taxData.period.periodId, deadline: inp.value.trim() }, function () { closeModal(); loadTax(taxData.period.periodId); }, function (e) { fail(e.message); }); });
  }

  /* 客戶資料（CompanyProfile）：逐家編輯，可勾選多家批次設定 */
  /** 某公司的 LINE 收件人設定（發票資料、請款付款兩類）：取消勾選＝這類訊息不發給他；全部勾選＝預設（全部有效綁定帳號都收） */
  function recipientsDialog(companyId, name) {
    var m = openModal('LINE 收件人：' + name);
    var box = el('div', { class: 'muted' }, '載入中…'); m.appendChild(box);
    call('tax.getRecipients', { companyId: companyId }, function (r) {
      box.remove();
      if (!r.users.length) { m.appendChild(el('div', { class: 'muted' }, '這家公司還沒有綁定 LINE 的帳號，客戶綁定後才能設定。')); }
      else m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '預設是這家公司全部有效的綁定帳號都收。有些訊息只想發給特定的人時，取消勾選其他人。新綁定的帳號預設會收。'));
      var state = {};
      r.classes.forEach(function (c) {
        var card = el('div', { class: 'card', style: 'margin-bottom:8px' });
        card.appendChild(el('div', { class: 'card-title' }, c.label + (c.key === 'INVOICE' ? '（第一次、第二次通知）' : '（請款通知、催款）') + (c.customized ? '　已自訂' : '')));
        state[c.key] = [];
        r.users.forEach(function (u) {
          var cb = el('input', { type: 'checkbox' }); cb.checked = c.excluded.indexOf(u.userId) < 0;
          var ln = el('label', { style: 'display:flex;gap:6px;align-items:center;padding:2px 0' }); ln.appendChild(cb); ln.appendChild(el('span', {}, u.name));
          card.appendChild(ln); state[c.key].push([u.userId, cb]);
        });
        m.appendChild(card);
      });
      var bar = el('div', { class: 'actions' }), cancel = el('button', { class: 'btn secondary' }, '返回'), save = el('button', { class: 'btn' }, '儲存'), msg = el('span', { class: 'muted' });
      cancel.onclick = function () { profilesDialog(); };
      save.disabled = !r.users.length || !r.canWrite;
      save.onclick = function () {
        save.disabled = true; msg.textContent = '儲存中…';
        var keys = Object.keys(state), i = 0;
        (function next() {
          if (i >= keys.length) { profilesDialog(); return; }
          var k = keys[i++], ex = state[k].filter(function (x) { return !x[1].checked; }).map(function (x) { return x[0]; });
          call('tax.saveRecipients', { companyId: companyId, classKey: k, excludedUserIds: ex }, next, function (e) { save.disabled = false; msg.textContent = e.message; });
        })();
      };
      bar.appendChild(msg); bar.appendChild(cancel); bar.appendChild(save); m.appendChild(bar);
    }, function (e) { box.textContent = e.message; });
  }

  function profilesDialog() {
    var m = openModal('客戶資料（稅務）'); $('modal').style.width = 'min(1000px,96vw)';
    var box = el('div', { class: 'muted' }, '載入中…'); m.appendChild(box);
    call('tax.listProfiles', {}, function (pd) {
      box.remove();
      if (!pd.canWrite) m.appendChild(el('div', { class: 'alert' }, '系統同步異常，目前只能查看，不能儲存。'));
      var tools = el('div', { class: 'toolbar' }); m.appendChild(tools);
      var rowsUi = [];
      var t = el('table', { style: 'min-width:840px' }), cg = el('colgroup'); ['34px', '90px', '', '110px', '100px', '150px', '84px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
      var h = el('tr'); ['', '統一編號', '公司全名', '簡稱', '繳納方式', '申報注意事項', '收件人'].forEach(function (x) { h.appendChild(el('th', { style: 'position:sticky;top:0;z-index:2;background:#fff;box-shadow:0 1px 0 var(--line)' }, x)); }); t.appendChild(h);
      pd.profiles.forEach(function (p) {
        var tr = el('tr'), c0 = el('td'), cb = el('input', { type: 'checkbox' }); c0.appendChild(cb); tr.appendChild(c0);
        tr.appendChild(el('td', {}, p.companyId)); tr.appendChild(el('td', {}, p.fullName || p.companyName));
        var sn = el('input', { type: 'text', maxlength: '30' }); sn.value = p.shortName || p.companyName; var td3 = el('td'); td3.appendChild(sn); tr.appendChild(td3);
        var pm = el('select'); [['AGENT_PAY', '代繳'], ['SELF_PAY', '自繳']].forEach(function (x) { var o = el('option', { value: x[0] }, x[1]); if (p.vatPaymentMethod === x[0]) o.selected = true; pm.appendChild(o); });
        var td5 = el('td'); td5.appendChild(pm); tr.appendChild(td5);
        var tn = el('input', { type: 'text', maxlength: '500' }); tn.value = p.taxNotes; var td6 = el('td'); td6.appendChild(tn); tr.appendChild(td6);
        var td7 = el('td'), rb = el('button', { class: 'linkbtn', title: '設定這家公司的 LINE 收件人（發票資料、請款付款兩類）' }, '設定'); rb.onclick = function () { recipientsDialog(p.companyId, p.shortName || p.companyName); }; td7.appendChild(rb); tr.appendChild(td7);
        t.appendChild(tr);
        rowsUi.push({ p: p, cb: cb, sn: sn, pm: pm, tn: tn });
      });
      function sel(fn) { rowsUi.forEach(function (u) { if (u.cb.checked) fn(u); }); }
      [['勾選的設為代繳', function (u) { u.pm.value = 'AGENT_PAY'; }], ['勾選的設為自繳', function (u) { u.pm.value = 'SELF_PAY'; }]].forEach(function (x) {
        var b = el('button', { class: 'btn small secondary' }, x[0]); b.onclick = function () { sel(x[1]); }; tools.appendChild(b);
      });
      var allCb = el('button', { class: 'btn small secondary' }, '全選／全不選'); var on = false; allCb.onclick = function () { on = !on; rowsUi.forEach(function (u) { u.cb.checked = on; }); }; tools.appendChild(allCb);
      var wrap = el('div', { style: 'max-height:56vh;overflow:auto' }); wrap.appendChild(t); m.appendChild(wrap);
      modalActions(m, '儲存有改動的公司', function (fail) {
        var items = [];
        rowsUi.forEach(function (u) {
          var p = u.p, it = { companyId: p.companyId };
          if (u.sn.value.trim() !== (p.shortName || p.companyName)) it.shortName = u.sn.value.trim();
          if (u.pm.value !== p.vatPaymentMethod) it.vatPaymentMethod = u.pm.value;
          if (u.tn.value.trim() !== p.taxNotes) it.taxNotes = u.tn.value.trim();
          if (Object.keys(it).length > 1) { if (!p.hasProfile) { it.shortName = u.sn.value.trim(); it.vatPaymentMethod = u.pm.value; } items.push(it); }
        });
        if (!items.length) return fail('沒有任何改動。');
        var chunks = [], i; for (i = 0; i < items.length; i += 60) chunks.push(items.slice(i, i + 60));
        (function next() {
          if (!chunks.length) { closeModal(); alert('已儲存 ' + items.length + ' 家。'); return taxData && taxData.period ? loadTax(taxData.period.periodId) : null; }
          call('tax.saveProfiles', { items: chunks.shift() }, next, function (e) { fail(e.message); });
        })();
      });
    }, function (e) { box.textContent = e.message; });
  }

  /* ---------- 上傳請款單（M1 7.1）：瀏覽器讀 PDF → 伺服器檢查 → 預覽 → 存雲端硬碟（Apps Script）→ 寫入資料庫（閘道） ---------- */
  var PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/';
  var pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) pdfjsPromise = import(PDFJS_BASE + 'pdf.min.mjs').then(function (m) { m.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs'; return m; });
    return pdfjsPromise;
  }
  var ups = [], upBusy = false, billsInfo = null;

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function toBase64(buf) {
    var bytes = new Uint8Array(buf), s = '', i, CH = 0x8000;
    for (i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  /** 讀一個 PDF：回傳 { hash, buf, parse（bill-parser 結果） } */
  function readPdfFile(file) {
    return file.arrayBuffer().then(function (buf) {
      return Promise.all([crypto.subtle.digest('SHA-256', buf), loadPdfjs()]).then(function (r) {
        var hash = hex(r[0]);
        return r[1].getDocument({ data: new Uint8Array(buf.slice(0)), useSystemFonts: true }).promise.then(function (doc) {
          var pages = [], p = Promise.resolve();
          for (var n = 1; n <= doc.numPages; n++) (function (num) {
            p = p.then(function () {
              return doc.getPage(num).then(function (page) {
                var vp = page.getViewport({ scale: 1 });
                return page.getTextContent().then(function (tc) {
                  pages.push({ items: tc.items.filter(function (i) { return i.str && i.str.trim(); }).map(function (i) { return { str: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width }; }) });
                });
              });
            });
          })(n);
          return p.then(function () { return { hash: hash, buf: buf, parse: window.YcBillParser.parseBill(pages) }; });
        });
      });
    });
  }

  function loadBillsStatus() {
    call('tax.billsStatus', {}, function (s) { billsInfo = s; renderUpStatus(); }, function (e) { $('upStatus').textContent = e.message; });
  }
  function renderUpStatus() {
    var box = $('upStatus'); box.innerHTML = '';
    var s = billsInfo; if (!s) return;
    if (!s.enabled) {
      var warn = el('div', { class: 'alert' }, '尚未啟用「客戶請款單」資料夾（請款單 PDF 會存在這裡，客戶看不到）。');
      if (me && me.role === 'SUPER_ADMIN') {
        var b = el('button', { class: 'btn small', style: 'margin-left:8px' }, '啟用請款單資料夾');
        b.onclick = function () { if (confirm('將在雲端硬碟「客戶資料」的上一層建立「客戶請款單」資料夾（不分享給客戶），並依負責公司授權管理員。確定啟用？')) call('tax.billsSetup', {}, function () { loadBillsStatus(); }); };
        warn.appendChild(b);
      } else warn.appendChild(document.createTextNode('請超級管理員先啟用。'));
      box.appendChild(warn);
    } else box.appendChild(el('div', { class: 'muted' }, '存放位置：' + s.folderName + '（每家公司一個子資料夾；客戶沒有權限，每位管理員只有自己負責公司的權限）'));
    if (s.enabled && !s.hasReceiptKey) box.appendChild(el('div', { class: 'alert' }, '尚未設定「檔案收據金鑰」（Apps Script 指令碼屬性 BILL_RECEIPT_KEY），暫時無法匯入。請聯絡維護人員。'));
  }

  function upHard(u) { return (u.check.errors || []).filter(function (e) { return !e.overridable && e.code !== 'B5'; }); }
  function upNeedReplace(u) { return (u.check.errors || []).some(function (e) { return e.code === 'B5'; }); }
  function upNeedReason(u) { return (u.check.errors || []).some(function (e) { return e.overridable; }); }
  function upReady(u) {
    if (!u.check || u.state === 'done') return false;
    if (upHard(u).length) return false;
    if (upNeedReplace(u) && !u.replace && !u.coexist) return false;
    if (upNeedReason(u) && (u.reason || '').trim().length < 2) return false;
    return true;
  }

  function addUploadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) { return /\.pdf$/i.test(f.name); });
    if (!files.length) return alert('請選擇 PDF 檔案。');
    upBusy = true; $('upProgress').textContent = '讀取中…'; updateUpButtons();
    var added = [], p = Promise.resolve();
    files.forEach(function (f, i) {
      p = p.then(function () {
        $('upProgress').textContent = '讀取 PDF（' + (i + 1) + '／' + files.length + '）…';
        return readPdfFile(f).then(function (r) {
          var u = { file: f, name: f.name, hash: r.hash, buf: r.buf, parse: r.parse, include: true, replace: false, coexist: false, reason: '', state: '', check: null };
          added.push(u); ups.push(u);
        }, function () {
          var u = { file: f, name: f.name, hash: '', buf: null, parse: { ok: false, message: '無法讀取這個 PDF（檔案損毀或有密碼）' }, include: false, state: '', check: null };
          added.push(u); ups.push(u);
        });
      });
    });
    p.then(function () {
      var okOnes = added.filter(function (u) { return u.parse.ok; });
      added.filter(function (u) { return !u.parse.ok; }).forEach(function (u) { u.check = { status: 'PENDING', errors: [{ code: 'PARSE', message: u.parse.message }], warnings: [], items: [] }; u.include = false; });
      var chunks = []; for (var i = 0; i < okOnes.length; i += 40) chunks.push(okOnes.slice(i, i + 40));
      function next() {
        if (!chunks.length) { upBusy = false; $('upProgress').textContent = ''; renderUploads(); return; }
        var c = chunks.shift();
        $('upProgress').textContent = '檢查中…';
        call('tax.checkBills', { files: c.map(function (u) { return { fileName: u.name, fileHash: u.hash, parsed: u.parse.bill, advanceLinks: u.advLinks }; }) }, function (d) {
          d.results.forEach(function (r, k) { c[k].check = r; c[k].parse.warnings = c[k].parse.warnings || []; c[k].include = !upHard(c[k]) .length && r.status === 'OK'; });
          var again = c.filter(upInitLinks);   // 名稱含「代墊」且只有一筆未收回代墊 → 先猜（套用後重新檢查一次）
          (function re() { if (!again.length) return next(); upRecheck(again.shift(), re); })();
        }, function (e) { c.forEach(function (u) { u.check = { status: 'PENDING', errors: [{ code: 'CHECK', message: e.message }], warnings: [], items: [] }; u.include = false; }); next(); });
      }
      next();
    });
  }

  /** 補收代墊（M2 八之一）：系統先猜的項目套用到 u.advLinks；回傳 true＝有套用，需要重新檢查 */
  function upInitLinks(u) {
    var r = u.check; if (!r || !r.items || u.advLinks) return false;
    var links = {}, n = 0;
    r.items.forEach(function (i) { if (i.suggestAdvanceId) { links[i.seq] = i.suggestAdvanceId; n++; } });
    if (!n) return false;
    u.advLinks = links; return true;
  }
  /** 重新檢查單一份（業主改了補收代墊的選擇，類別、警示與金額驗證要跟著更新） */
  function upRecheck(u, done) {
    call('tax.checkBills', { files: [{ fileName: u.name, fileHash: u.hash, parsed: u.parse.bill, advanceLinks: u.advLinks }] }, function (d) {
      u.check = d.results[0]; if (upHard(u).length) u.include = false;
      if (done) done(); else renderUploads();
    }, function (e) { alert(e.message); if (done) done(); else renderUploads(); });
  }
  function advOptionText(a) { return '補收代墊：' + (a.periodLabel || '') + ' ' + (ADV_TAX[a.taxType] || '') + ' 代墊 ' + fmtMoney(a.amount) + '（還剩 ' + fmtMoney(a.remaining) + '）'; }

  function fmtMoney(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function renderUploads() {
    var box = $('upBox'); box.innerHTML = '';
    if (!ups.length) { box.appendChild(el('div', { class: 'muted' }, '把請款明細表 PDF 拖到上方，或按「選擇檔案」。可一次選多個；讀取在您的瀏覽器內進行，確認後才會存檔與寫入。')); updateUpButtons(); return; }
    var t = el('table'), cg = el('colgroup'); ['34px', '', '120px', '70px', '80px', '110px', ''].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
    var h = el('tr'); ['', '檔案', '公司', '帳期', '合計', '結果', '說明／處理'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
    ups.forEach(function (u) {
      var c = u.check, b = u.parse.ok ? u.parse.bill : null, tr = el('tr');
      var c0 = el('td'), cb = el('input', { type: 'checkbox' }); cb.checked = !!u.include && u.state !== 'done'; cb.disabled = !c || !!upHard(u).length || u.state === 'done' || upBusy;
      cb.onchange = function () { u.include = cb.checked; updateUpButtons(); }; c0.appendChild(cb); tr.appendChild(c0);
      tr.appendChild(el('td', { title: u.name }, u.name.length > 28 ? u.name.slice(0, 27) + '…' : u.name));
      tr.appendChild(el('td', {}, c && c.companyName ? c.companyName : (b ? b.taxId : '—')));
      tr.appendChild(el('td', {}, b ? b.billingPeriod : '—'));
      tr.appendChild(el('td', {}, b ? fmtMoney(b.total) : '—'));
      var st = el('td');
      if (u.state === 'done') st.appendChild(badge('已匯入', 'ok'));
      else if (u.state === 'failed') st.appendChild(badge('匯入失敗', 'err'));
      else if (!c) st.appendChild(badge('檢查中', 'off'));
      else if (c.status === 'OK') st.appendChild(badge(c.warnings && c.warnings.length ? '通過（有提醒）' : '通過', 'ok'));
      else st.appendChild(badge('待確認', 'warn'));
      tr.appendChild(st);
      var note = el('td');
      if (u.msg) note.appendChild(el('div', { class: u.state === 'done' ? 'msg ok' : 'msg err' }, u.msg));
      if (c) {
        if (c.kind && c.kind !== 'GENERAL') note.appendChild(el('div', { class: 'muted' }, '請款類別：' + ({ PREPAY: '暫繳', CIT: '營所稅', PIT: '綜所稅', UNDIST: '未分配盈餘稅' }[c.kind] || c.kind) + '（與營業稅請款單分開，各自期限與對帳）'));
        (c.errors || []).forEach(function (e) { note.appendChild(el('div', { class: 'msg err' }, '✖ ' + e.message)); });
        (c.warnings || []).concat(u.parse.warnings || []).forEach(function (w) { note.appendChild(el('div', { class: 'muted' }, '⚠ ' + w)); });
        if (u.state !== 'done' && !upHard(u).length && upNeedReplace(u)) {
          var lab = el('label', { style: 'display:block;margin-top:4px' }), rc = el('input', { type: 'checkbox' }); rc.checked = !!u.replace;
          var lab2 = el('label', { style: 'display:block;margin-top:4px' }), rc2 = el('input', { type: 'checkbox' }); rc2.checked = !!u.coexist;
          rc.onchange = function () { u.replace = rc.checked; if (u.replace) { u.include = true; u.coexist = false; rc2.checked = false; } updateUpButtons(); };
          rc2.onchange = function () { u.coexist = rc2.checked; if (u.coexist) { u.include = true; u.replace = false; rc.checked = false; } updateUpButtons(); };
          lab.appendChild(rc); lab.appendChild(document.createTextNode(' 取代原有請款單（同類別；原單已收的款會一併帶到新單）' + (c.existingSent ? '（原單已發送，取代後新單需重新發送）' : ''))); note.appendChild(lab);
          lab2.appendChild(rc2); lab2.appendChild(document.createTextNode(' 並存（原單保留，另外新增一張）')); note.appendChild(lab2);
        }
        if (u.state !== 'done' && !upHard(u).length && upNeedReason(u)) {
          var ri = el('input', { type: 'text', placeholder: '確認無誤仍要匯入：請填原因（會留紀錄）', style: 'margin-top:4px' }); ri.value = u.reason || '';
          ri.oninput = function () { u.reason = ri.value; updateUpButtons(); }; note.appendChild(ri);
        }
        if (c.items && c.items.length) {
          var hasAdv = !!(c.advances && c.advances.length) && u.state !== 'done';
          var det = el('details', hasAdv ? { open: 'open', style: 'margin-top:4px' } : { style: 'margin-top:4px' }); det.appendChild(el('summary', { class: 'muted' }, '項目明細（' + c.items.length + ' 項）'));
          if (hasAdv) det.appendChild(el('div', { class: 'alert', style: 'margin:4px 0' }, '這家客戶有 ' + c.advances.length + ' 筆未收回的代墊，請確認有沒有要併入這張請款單補收；要補收的項目請用項目下方的選單選「補收代墊」。'));
          c.items.forEach(function (i) {
            var line = el('div', { class: 'muted', style: 'margin:2px 0' }, i.label + '：' + fmtMoney(i.amount) + '　→ ' + i.categoryLabel + (i.periodKey ? '（' + i.periodKey + '）' : ''));
            if (hasAdv && i.category !== 'BOOKKEEPING') {
              var sel = el('select', { style: 'width:auto;max-width:100%;margin-left:6px' }); sel.disabled = upBusy;
              sel.appendChild(el('option', { value: '' }, '一般項目'));
              c.advances.forEach(function (a) { sel.appendChild(el('option', { value: a.advanceId }, advOptionText(a))); });
              sel.value = (u.advLinks && u.advLinks[i.seq]) || '';
              sel.onchange = function () {
                var nl = {}; Object.keys(u.advLinks || {}).forEach(function (k) { nl[k] = u.advLinks[k]; });
                if (sel.value) nl[i.seq] = sel.value; else delete nl[i.seq];
                u.advLinks = nl; upRecheck(u);
              };
              line.appendChild(sel);
            }
            det.appendChild(line);
          });
          if (c.storedName) det.appendChild(el('div', { class: 'muted' }, '存檔：' + c.folderName + ' ／ ' + c.storedName));
          note.appendChild(det);
        }
      }
      tr.appendChild(note); t.appendChild(tr);
    });
    box.appendChild(t); updateUpButtons();
  }

  function updateUpButtons() {
    var n = ups.filter(function (u) { return u.include && upReady(u); }).length;
    $('upImportBtn').disabled = upBusy || !n || !(billsInfo && billsInfo.enabled && billsInfo.hasReceiptKey);
    $('upImportBtn').textContent = '匯入勾選的 ' + n + ' 份';
    $('upClearBtn').disabled = upBusy || !ups.length;
  }

  function runImport() {
    var list = ups.filter(function (u) { return u.include && upReady(u); });
    if (!list.length) return;
    if (!confirm('確定匯入 ' + list.length + ' 份請款單？PDF 會存入雲端硬碟「客戶請款單」資料夾。')) return;
    upBusy = true; updateUpButtons();
    var ok = 0, fail = 0, i = 0;
    (function next() {
      if (i >= list.length) { upBusy = false; $('upProgress').textContent = '完成：成功 ' + ok + ' 份，失敗 ' + fail + ' 份。'; renderUploads(); return; }
      var u = list[i++]; $('upProgress').textContent = '匯入 ' + i + '／' + list.length + '：' + u.name;
      var c = u.check, b = u.parse.bill, short = (c.folderName || '').slice(b.taxId.length + 1);
      call('tax.storeFile', { companyId: b.taxId, storedName: c.storedName, shortName: short, contentBase64: toBase64(u.buf) }, function (s) {
        call('tax.importBill', { fileName: u.name, parsed: b, receipt: s.receipt, storedName: c.storedName, advanceLinks: u.advLinks, replace: !!u.replace, coexist: !!u.coexist, override: u.reason && upNeedReason(u) ? { reason: u.reason.trim() } : undefined }, function (r) {
          u.state = 'done'; u.msg = '已匯入' + (r.linkedPeriods ? '，稅額已帶入 ' + r.linkedPeriods + ' 個期別的檢核列' : '') + (r.needsResend ? '（原單已發送，新單需重新發送）' : ''); u.include = false; ok++; renderUploads(); next();
        }, function (e) { u.state = 'failed'; u.msg = e.message + '（檔案已存入雲端硬碟，可重新檢查後再匯入，不會重複存檔）'; fail++; renderUploads(); next(); });
      }, function (e) { u.state = 'failed'; u.msg = e.message; fail++; renderUploads(); next(); });
    })();
  }

  (function () {
    wireDropZone($('upDrop'), $('upFile'), $('upPick'), /\.pdf$/i, true, addUploadFiles);
    $('upImportBtn').onclick = runImport;
    $('upClearBtn').onclick = function () { ups = []; $('upProgress').textContent = ''; renderUploads(); };
    $('upBackBtn').onclick = function () { go('tax'); };
  })();
  function loadUploadPage() { ups = ups.filter(function (u) { return u.state !== 'done'; }); loadBillsStatus(); renderUploads(); }

  /* ---------- 模組設定（僅超級管理員）：檔名範本、請款項目類別、分類規則 ---------- */
  var setData = null;
  function loadTaxSettings() {
    $('setBox').textContent = '載入中…';
    call('tax.getSettings', {}, function (d) { setData = JSON.parse(JSON.stringify(d)); renderTaxSettings(); renderNoticeSettings(); renderDocSettings(); renderAdvanceSettings(); }, function (e) { $('setBox').textContent = e.message; });
  }
  function renderTaxSettings() {
    var d = setData, box = $('setBox'); box.innerHTML = '';
    if (!d.canWrite) box.appendChild(el('div', { class: 'alert' }, '系統同步異常，目前只能查看，不能儲存。'));

    var c1 = el('div', { class: 'card' }); c1.appendChild(el('div', { class: 'card-title' }, '檔名範本（存進雲端硬碟時的檔名）'));
    var tb = el('input', { type: 'text' }); tb.value = d.templates.bill; tb.oninput = function () { d.templates.bill = tb.value; };
    var ts = el('input', { type: 'text' }); ts.value = d.templates.slip; ts.oninput = function () { d.templates.slip = ts.value; };
    field(c1, '請款單', tb, '可用欄位：{公司全名} {簡稱} {統編} {帳期} {期別}；只影響之後新存的檔案，舊檔案不改名。');
    field(c1, '繳款書（日後使用）', ts);
    box.appendChild(c1);

    var c2 = el('div', { class: 'card' }); c2.appendChild(el('div', { class: 'card-title' }, '請款項目類別'));
    c2.appendChild(el('div', { class: 'muted' }, '「稅金」欄填稅別代碼（例如 VAT、PREPAY）表示這類項目是稅金；非稅金留空。「其他費用」必須保留（找不到規則時的預設）。停用的類別不會再被新匯入歸入。'));
    var t2 = el('table'), cg2 = el('colgroup'); ['130px', '', '110px', '70px', '60px'].forEach(function (w) { cg2.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t2.appendChild(cg2);
    var h2 = el('tr'); ['代碼', '名稱', '稅金（稅別代碼）', '停用', ''].forEach(function (x) { h2.appendChild(el('th', {}, x)); }); t2.appendChild(h2);
    d.categories.forEach(function (c, idx) {
      var tr = el('tr'), td = function (ch) { var x = el('td'); x.appendChild(ch); tr.appendChild(x); };
      var code = el('input', { type: 'text' }); code.value = c.code; code.oninput = function () { c.code = code.value.trim().toUpperCase(); };
      var lab = el('input', { type: 'text' }); lab.value = c.label; lab.oninput = function () { c.label = lab.value; };
      var tx = el('input', { type: 'text' }); tx.value = c.taxType || ''; tx.oninput = function () { c.taxType = tx.value.trim().toUpperCase(); };
      var dis = el('input', { type: 'checkbox' }); dis.checked = !!c.disabled; dis.onchange = function () { c.disabled = dis.checked; };
      var del = el('button', { class: 'linkbtn', style: 'color:#b42318' }, '刪除'); del.onclick = function () { d.categories.splice(idx, 1); renderTaxSettings(); };
      td(code); td(lab); td(tx); td(dis); td(del); t2.appendChild(tr);
    });
    c2.appendChild(t2);
    var add2 = el('button', { class: 'btn small secondary' }, '新增類別'); add2.onclick = function () { d.categories.push({ code: 'NEW_' + (d.categories.length + 1), label: '新類別', taxType: '' }); renderTaxSettings(); }; c2.appendChild(add2);
    box.appendChild(c2);

    var c3 = el('div', { class: 'card' }); c3.appendChild(el('div', { class: 'card-title' }, '分類規則（由上而下，第一個符合的生效；都不符合 → 其他費用）'));
    c3.appendChild(el('div', { class: 'muted' }, '關鍵字用「、」分隔，帳名含其中任何一個就符合。「結算申報費」「申報費」要排在含稅名的規則之前，避免被當成稅金。'));
    var t3 = el('table'), cg3 = el('colgroup'); ['', '170px', '120px'].forEach(function (w) { cg3.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t3.appendChild(cg3);
    var h3 = el('tr'); ['含有關鍵字', '歸入類別', ''].forEach(function (x) { h3.appendChild(el('th', {}, x)); }); t3.appendChild(h3);
    d.rules.forEach(function (r, idx) {
      var tr = el('tr'), td = function (ch) { var x = el('td'); x.appendChild(ch); tr.appendChild(x); };
      var kw = el('input', { type: 'text' }); kw.value = r.contains.join('、'); kw.oninput = function () { r.contains = kw.value.split(/[、,，]/).map(function (s) { return s.trim(); }).filter(Boolean); };
      var sel = el('select'); d.categories.forEach(function (c) { var o = el('option', { value: c.code }, c.label); if (c.code === r.category) o.selected = true; sel.appendChild(o); });
      sel.onchange = function () { r.category = sel.value; };
      var ops = el('div');
      var up = el('button', { class: 'linkbtn' }, '上移'), dn = el('button', { class: 'linkbtn' }, '下移'), del = el('button', { class: 'linkbtn', style: 'color:#b42318' }, '刪除');
      up.onclick = function () { if (idx > 0) { d.rules.splice(idx - 1, 0, d.rules.splice(idx, 1)[0]); renderTaxSettings(); } };
      dn.onclick = function () { if (idx < d.rules.length - 1) { d.rules.splice(idx + 1, 0, d.rules.splice(idx, 1)[0]); renderTaxSettings(); } };
      del.onclick = function () { d.rules.splice(idx, 1); renderTaxSettings(); };
      [up, document.createTextNode(' '), dn, document.createTextNode(' '), del].forEach(function (x) { ops.appendChild(x); });
      td(kw); td(sel); td(ops); t3.appendChild(tr);
    });
    c3.appendChild(t3);
    var add3 = el('button', { class: 'btn small secondary' }, '新增規則'); add3.onclick = function () { d.rules.push({ contains: [''], category: 'OTHER_FEE' }); renderTaxSettings(); }; c3.appendChild(add3);
    var test = el('div', { class: 'toolbar', style: 'margin-top:12px' });
    var ti = el('input', { type: 'text', placeholder: '測試：輸入一個帳名（例：07-08月份營業稅）', style: 'max-width:340px' }), tbtn = el('button', { class: 'btn small secondary' }, '測試歸類'), tout = el('span', { class: 'muted' });
    tbtn.onclick = function () {
      call('tax.testClassify', { label: ti.value, rules: d.rules.filter(function (r) { return r.contains.length; }), categories: d.categories }, function (r) {
        tout.textContent = '→ ' + r.categoryLabel + (r.taxType ? '（稅金：' + r.taxType + (r.periodKey ? '，期別 ' + r.periodKey : '，期別尚未建立') + '）' : '');
      }, function (e) { tout.textContent = e.message; });
    };
    test.appendChild(ti); test.appendChild(tbtn); test.appendChild(tout); c3.appendChild(test);
    box.appendChild(c3);

    var bar = el('div', { class: 'actions' }), msg = el('div', { class: 'msg' });
    var reset = el('button', { class: 'btn secondary' }, '還原預設'), save = el('button', { class: 'btn' }, '儲存'); save.disabled = !d.canWrite;
    reset.onclick = function () { if (!confirm('把類別、規則、檔名範本全部改回預設值（尚未儲存前可重新整理取消）？')) return; setData.categories = JSON.parse(JSON.stringify(d.defaults.categories)); setData.rules = JSON.parse(JSON.stringify(d.defaults.rules)); setData.templates = JSON.parse(JSON.stringify(d.defaults.templates)); renderTaxSettings(); };
    save.onclick = function () {
      save.disabled = true; msg.className = 'msg'; msg.textContent = '儲存中…';
      call('tax.saveSettings', { categories: d.categories.map(function (c) { return { code: c.code, label: c.label, taxType: c.taxType || '', disabled: !!c.disabled }; }), rules: d.rules.filter(function (r) { return r.contains.length; }), templateBill: d.templates.bill, templateSlip: d.templates.slip },
        function () { msg.className = 'msg ok'; msg.textContent = '已儲存，之後新匯入的請款單立即套用。'; save.disabled = false; },
        function (e) { msg.className = 'msg err'; msg.textContent = e.message; save.disabled = false; });
    };
    bar.appendChild(reset); bar.appendChild(save); box.appendChild(msg); box.appendChild(bar);
  }
  $('setBackBtn').onclick = function () { go('tax'); };

  (function start() {
    // LINE Login 回到本頁：以 code／state 向後端換取登入
    if (params.get('code') || params.get('error')) {
      var args = { code: params.get('code') || '', state: params.get('state') || '', error: params.get('error') || '' };
      if (GATEWAY_URL && GATEWAY_ACTIONS.getHome) args.noHome = true; // 首頁改走快速通道，登入回應不必再算一次
      cleanUrl();
      showBusy('登入中，請稍候…');
      api('callback', args).then(function (r) {
        hideBusy();
        if (r.sessionToken) {
          token = r.sessionToken; store(TOKEN_KEY, token); setJwt(r.auth);
          if (r.home) { showApp(r.home); if (r.notice) alert(r.notice); return; }
          return enter(r.notice);
        }
        showLogin(r.error || '', r.notice || '');
      }, function (err) { hideBusy(); showLogin(err.message); });
      return;
    }
    if (params.get('invite')) { loginPurpose = { invite: params.get('invite') }; cleanUrl(); return showPurposePrompt('invite'); }
    if (params.get('vae')) { loginPurpose = { vae: params.get('vae') }; cleanUrl(); return showPurposePrompt('vae'); }
    token = load(TOKEN_KEY);
    if (!token) return showLogin('', '');
    restoreJwt();
    enter('');
  })();
})();
