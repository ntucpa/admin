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
  var READ_ONLY = { ping: 1, loginUrl: 1, getHome: 1, getSettings: 1, listCompanies: 1, getUnclassifiedFolder: 1, listAdmins: 1, checkEmail: 1, listBindings: 1, listCustomers: 1, customerHistory: 1, listInvites: 1, listUnclassified: 1, listExceptions: 1, takeoverReport: 1, listAudit: 1, driveAudit: 1, previewCompanyImport: 1, listIntake: 1, listBackups: 1, 'tax.getBoard': 1, 'tax.getHome': 1, 'tax.memoSummary': 1, 'tax.listProfiles': 1, 'tax.checkBills': 1, 'tax.getSettings': 1, 'tax.testClassify': 1, 'tax.billsStatus': 1 };
  var NET_ERR = 'Google 連線暫時不穩，請稍後再試一次。若是儲存或新增，請先重新整理頁面確認是否已完成，避免重複操作。';

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw { code: 'NETWORK', message: NET_ERR };
        var route = r.headers.get('x-yc-route') || '';
        return r.json().then(function (j) { j._route = route; return j; }, function () { throw { code: 'NETWORK', message: NET_ERR }; });
      }, function () { throw { code: 'NETWORK', message: NET_ERR }; });
  }

  function once(name, args, t0) {
    var action = 'admin.' + name;
    var direct = function () { return post(API_URL, { action: action, token: token, args: args || {} }); };
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
    var tries = READ_ONLY[name] ? 3 : 1;
    function attempt(n) {
      return once(name, args, t0).then(null, function (err) {
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
    document.querySelectorAll('nav a[data-feature]').forEach(function (n) { n.classList.toggle('hidden', (me.features || []).indexOf(n.getAttribute('data-feature')) < 0); });
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
      $('statUsageNote').textContent = rn.stopped
        ? (rn.lastHeartbeatAt ? '背景處理已停止，可能是今日額度已用完，請稍後查看或聯絡系統維護人員' : '背景處理尚未啟動')
        : '最後運作：' + fmtTime(rn.lastHeartbeatAt) + (rn.hasPendingWork ? '｜有工作處理中' : '');
    }
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
    var navPage = (page === 'taxup' || page === 'taxsettings') ? 'tax' : page;
    document.querySelectorAll('nav a[data-page]').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-page') === navPage); });
    document.querySelectorAll('main section').forEach(function (s) { s.classList.toggle('hidden', s.id !== 'page-' + page); });
    document.querySelector('main').style.maxWidth = (page === 'tax' || page === 'taxup' || page === 'taxsettings') ? 'none' : '';
    if (page === 'taxup') loadUploadPage();
    if (page === 'taxsettings') loadTaxSettings();
    if (page === 'tax') loadTax();
    if (page === 'home') call('getHome', {}, renderHome);
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
    if (page === 'settings') { loadUnclassified(); loadSettings(); }
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
        tr.appendChild(el('td', {}, c.name + (c.fullName ? '（' + c.fullName + '）' : '')));
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
        if (b.companyIssue) { c2.appendChild(badge(b.companyIssue, 'err')); c2.appendChild(el('div', { class: 'muted' }, '請先到「公司管理」完成設定才能核准')); }
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
          var r = el('button', { class: 'btn small danger' }, '撤銷');
          r.onclick = function () { if (confirm('確定撤銷「' + i.companyName + '」的邀請連結？撤銷後客戶將無法使用。')) call('revokeInvite', { inviteId: i.inviteId }, loadInvites); };
          op.appendChild(r);
        } else if (i.status === 'EXPIRED' || i.status === 'REVOKED') {
          var again = el('button', { class: 'btn small secondary' }, '重新建立');
          again.onclick = function () { createInvite(i.companyId); };
          op.appendChild(again);
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
    call('createInvite', { companyId: companyId }, function (r) {
      var m = openModal('邀請連結已建立');
      m.appendChild(el('div', {}, '公司：' + r.companyName));
      var box = el('div', { class: 'linkbox' });
      var input = el('input', { type: 'text', readonly: 'readonly' }); input.value = r.url;
      var copy = el('button', { class: 'btn' }, '複製連結');
      copy.onclick = function () {
        input.select();
        var done = function () { copy.textContent = '已複製 ✓'; };
        if (navigator.clipboard) navigator.clipboard.writeText(r.url).then(done, function () { document.execCommand('copy'); done(); });
        else { document.execCommand('copy'); done(); }
      };
      box.appendChild(input); box.appendChild(copy); m.appendChild(box);
      m.appendChild(el('p', { class: 'muted' }, '請把連結用 LINE 傳給客戶，客戶需在手機 LINE 裡點開。有效期限至 ' + fmtTime(r.expireAt) + '，只能使用一次。'));
      m.appendChild(el('div', { class: 'alert' }, '為了安全，連結只會顯示這一次，關閉後無法再查看。若遺失，請撤銷後重新建立。'));
      var bar = el('div', { class: 'actions' }); var close = el('button', { class: 'btn secondary' }, '關閉');
      close.onclick = function () { closeModal(); loadInvites(); }; bar.appendChild(close); m.appendChild(bar);
    }, function (e) { if (fail) fail(e.message); else alert(e.message); });
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
    call('tax.getBoard', { taxType: 'VAT', periodId: periodId || undefined }, function (d) { taxData = d; taxSel = {}; renderTax(); },
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

  /* ---------- 首頁區塊（P4）：期限列、異常、我的備忘、待辦卡片、整體進度、LINE 綁定進度 ---------- */
  var taxHomeData = null;
  function loadTaxHome(periodId) {
    call('tax.getHome', { periodId: periodId || undefined }, function (h) { taxHomeData = h; renderTaxHome(); },
      function (e) { $('taxHome').textContent = e.message; });
  }
  function countdown(n) { if (n == null) return ''; if (n > 0) return '還有 ' + n + ' 天'; if (n === 0) return '今天截止'; return '已逾期 ' + (-n) + ' 天'; }

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
        det.appendChild(el('summary', { style: 'cursor:pointer;color:var(--danger)' }, (x.severity === 'high' ? '嚴重｜' : '') + x.label + '：' + x.items.length + ' 家'));
        x.items.forEach(function (it) { det.appendChild(el('div', { style: 'padding:2px 0 2px 18px;font-size:13px' }, it.name + '　' + it.companyId + (it.note ? '　（' + it.note + '）' : ''))); });
        an.appendChild(det);
      });
      box.appendChild(an);
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
      var nm = el('td', { title: r.companyName }), nl = el('button', { class: 'linkbtn', style: 'text-decoration:none;color:inherit', title: '點一下查看或編輯備註' }, r.shortName || r.companyName);
      nl.onclick = function () { notesDialog(r); }; nm.appendChild(nl);
      if (r.note || r.taxNotes || r.bookkeepingNotes) { var ni = el('button', { class: 'linkbtn', style: 'text-decoration:none;margin-left:4px', title: [r.note, r.taxNotes, r.bookkeepingNotes].filter(Boolean).join('\n') }, 'ⓘ'); ni.onclick = function () { notesDialog(r); }; nm.appendChild(ni); }
      tr.appendChild(nm);
      var last = lastStep(r, d.steps);
      var pg = el('td'); pg.appendChild(r.applicable ? badge(last ? STEP_LABELS[last] : '未開始', last === 'FILED' ? 'ok' : (last ? '' : 'off')) : badge('不適用', 'off')); tr.appendChild(pg);
      d.steps.forEach(function (code) {
        var td = el('td'), s = r.steps[code];
        var btn = el('button', { class: 'linkbtn', style: 'text-decoration:none' }, s && s.status === 'DONE' ? ('✔ ' + s.date.slice(5)) : '—');
        if (s && s.status === 'DONE') { btn.title = '操作人：' + (s.by || '') + '（點一下修改日期或清除）'; btn.style.color = 'var(--ok)'; } else btn.style.color = '#98a2b3';
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
    var m = openModal((r.shortName || r.companyName) + '　備註與注意事項');
    m.appendChild(el('div', { class: 'card-title' }, '申報注意事項')); m.appendChild(el('div', { style: 'white-space:pre-wrap;margin-bottom:12px' }, r.taxNotes || '（無）'));
    m.appendChild(el('div', { class: 'card-title' }, '帳務注意事項')); m.appendChild(el('div', { style: 'white-space:pre-wrap;margin-bottom:12px' }, r.bookkeepingNotes || '（無）'));
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
  function profilesDialog() {
    var m = openModal('客戶資料（稅務）'); $('modal').style.width = 'min(1000px,96vw)';
    var box = el('div', { class: 'muted' }, '載入中…'); m.appendChild(box);
    call('tax.listProfiles', {}, function (pd) {
      box.remove();
      if (!pd.canWrite) m.appendChild(el('div', { class: 'alert' }, '系統同步異常，目前只能查看，不能儲存。'));
      var tools = el('div', { class: 'toolbar' }); m.appendChild(tools);
      var rowsUi = [];
      var t = el('table', { style: 'min-width:840px' }), cg = el('colgroup'); ['34px', '90px', '', '110px', '100px', '150px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
      var h = el('tr'); ['', '統一編號', '公司全名', '簡稱', '繳納方式', '申報注意事項'].forEach(function (x) { h.appendChild(el('th', { style: 'position:sticky;top:0;z-index:2;background:#fff;box-shadow:0 1px 0 var(--line)' }, x)); }); t.appendChild(h);
      pd.profiles.forEach(function (p) {
        var tr = el('tr'), c0 = el('td'), cb = el('input', { type: 'checkbox' }); c0.appendChild(cb); tr.appendChild(c0);
        tr.appendChild(el('td', {}, p.companyId)); tr.appendChild(el('td', {}, p.fullName || p.companyName));
        var sn = el('input', { type: 'text', maxlength: '30' }); sn.value = p.shortName || p.companyName; var td3 = el('td'); td3.appendChild(sn); tr.appendChild(td3);
        var pm = el('select'); [['AGENT_PAY', '代繳'], ['SELF_PAY', '自繳']].forEach(function (x) { var o = el('option', { value: x[0] }, x[1]); if (p.vatPaymentMethod === x[0]) o.selected = true; pm.appendChild(o); });
        var td5 = el('td'); td5.appendChild(pm); tr.appendChild(td5);
        var tn = el('input', { type: 'text', maxlength: '500' }); tn.value = p.taxNotes; var td6 = el('td'); td6.appendChild(tn); tr.appendChild(td6);
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
    if (upNeedReplace(u) && !u.replace) return false;
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
          var u = { file: f, name: f.name, hash: r.hash, buf: r.buf, parse: r.parse, include: true, replace: false, reason: '', state: '', check: null };
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
        call('tax.checkBills', { files: c.map(function (u) { return { fileName: u.name, fileHash: u.hash, parsed: u.parse.bill }; }) }, function (d) {
          d.results.forEach(function (r, k) { c[k].check = r; c[k].parse.warnings = c[k].parse.warnings || []; c[k].include = !upHard(c[k]) .length && r.status === 'OK'; });
          next();
        }, function (e) { c.forEach(function (u) { u.check = { status: 'PENDING', errors: [{ code: 'CHECK', message: e.message }], warnings: [], items: [] }; u.include = false; }); next(); });
      }
      next();
    });
  }

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
        (c.errors || []).forEach(function (e) { note.appendChild(el('div', { class: 'msg err' }, '✖ ' + e.message)); });
        (c.warnings || []).concat(u.parse.warnings || []).forEach(function (w) { note.appendChild(el('div', { class: 'muted' }, '⚠ ' + w)); });
        if (u.state !== 'done' && !upHard(u).length && upNeedReplace(u)) {
          var lab = el('label', { style: 'display:block;margin-top:4px' }), rc = el('input', { type: 'checkbox' }); rc.checked = !!u.replace;
          rc.onchange = function () { u.replace = rc.checked; if (u.replace) u.include = true; updateUpButtons(); };
          lab.appendChild(rc); lab.appendChild(document.createTextNode(' 取代原有請款單' + (c.existingSent ? '（原單已發送，取代後新單需重新發送）' : ''))); note.appendChild(lab);
        }
        if (u.state !== 'done' && !upHard(u).length && upNeedReason(u)) {
          var ri = el('input', { type: 'text', placeholder: '確認無誤仍要匯入：請填原因（會留紀錄）', style: 'margin-top:4px' }); ri.value = u.reason || '';
          ri.oninput = function () { u.reason = ri.value; updateUpButtons(); }; note.appendChild(ri);
        }
        if (c.items && c.items.length) {
          var det = el('details', { style: 'margin-top:4px' }); det.appendChild(el('summary', { class: 'muted' }, '項目明細（' + c.items.length + ' 項）'));
          c.items.forEach(function (i) { det.appendChild(el('div', { class: 'muted' }, i.label + '：' + fmtMoney(i.amount) + '　→ ' + i.categoryLabel + (i.periodKey ? '（' + i.periodKey + '）' : ''))); });
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
        call('tax.importBill', { fileName: u.name, parsed: b, receipt: s.receipt, storedName: c.storedName, replace: !!u.replace, override: u.reason && upNeedReason(u) ? { reason: u.reason.trim() } : undefined }, function (r) {
          u.state = 'done'; u.msg = '已匯入' + (r.linkedPeriods ? '，稅額已帶入 ' + r.linkedPeriods + ' 個期別的檢核列' : '') + (r.needsResend ? '（原單已發送，新單需重新發送）' : ''); u.include = false; ok++; renderUploads(); next();
        }, function (e) { u.state = 'failed'; u.msg = e.message + '（檔案已存入雲端硬碟，可重新檢查後再匯入，不會重複存檔）'; fail++; renderUploads(); next(); });
      }, function (e) { u.state = 'failed'; u.msg = e.message; fail++; renderUploads(); next(); });
    })();
  }

  (function () {
    var dz = $('upDrop'), fi = $('upFile');
    $('upPick').onclick = function () { fi.click(); };
    fi.onchange = function () { if (fi.files.length) addUploadFiles(fi.files); fi.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.background = '#e8eef5'; }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.background = ''; }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addUploadFiles(e.dataTransfer.files); });
    $('upImportBtn').onclick = runImport;
    $('upClearBtn').onclick = function () { ups = []; $('upProgress').textContent = ''; renderUploads(); };
    $('upBackBtn').onclick = function () { go('tax'); };
  })();
  function loadUploadPage() { ups = ups.filter(function (u) { return u.state !== 'done'; }); loadBillsStatus(); renderUploads(); }

  /* ---------- 模組設定（僅超級管理員）：檔名範本、請款項目類別、分類規則 ---------- */
  var setData = null;
  function loadTaxSettings() {
    $('setBox').textContent = '載入中…';
    call('tax.getSettings', {}, function (d) { setData = JSON.parse(JSON.stringify(d)); renderTaxSettings(); }, function (e) { $('setBox').textContent = e.message; });
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
