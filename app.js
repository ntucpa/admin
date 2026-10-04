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

  /** 暖機：預先喚醒後端，縮短接下來真正操作的等待時間 */
  function warmUp() {
    fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'admin.ping' }) }).then(null, function () {});
  }

  /** 只讀取、不寫入的動作：遇到 Google 連線錯誤時可安全地自動重試 */
  var READ_ONLY = { ping: 1, loginUrl: 1, getHome: 1, getSettings: 1, listCompanies: 1, getUnclassifiedFolder: 1, listAdmins: 1, checkEmail: 1, listBindings: 1, listCustomers: 1, customerHistory: 1, listInvites: 1, listUnclassified: 1, listExceptions: 1, takeoverReport: 1, listAudit: 1 };
  var NET_ERR = 'Google 連線暫時不穩，請稍後再試一次。若是儲存或新增，請先重新整理頁面確認是否已完成，避免重複操作。';

  function once(name, args, t0) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'admin.' + name, token: token, args: args || {} })
    }).then(function (r) {
      if (!r.ok) throw { code: 'NETWORK', message: NET_ERR };
      return r.json().then(null, function () { throw { code: 'NETWORK', message: NET_ERR }; });
    }, function () {
      throw { code: 'NETWORK', message: NET_ERR };
    }).then(function (r) {
      $('perf').textContent = '最近一次操作：伺服器處理 ' + ((r.ms || 0) / 1000).toFixed(1) + ' 秒｜總耗時 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒';
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
  function closeModal() { $('overlay').classList.add('hidden'); $('modal').innerHTML = ''; }
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
    token = ''; store(TOKEN_KEY, '');
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
  }

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
    document.querySelectorAll('nav a[data-page]').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-page') === page); });
    document.querySelectorAll('main section').forEach(function (s) { s.classList.toggle('hidden', s.id !== 'page-' + page); });
    if (page === 'home') call('getHome', {}, renderHome);
    if (page === 'companies') loadCompanies();
    if (page === 'bindings') loadBindings();
    if (page === 'customers') loadCustomers();
    if (page === 'invites') loadInvites();
    if (page === 'unclassified') loadUncReminder();
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
        tr.appendChild(el('td', {}, c.name));
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
    var name = field(m, '公司全名', el('input', { type: 'text' }), '與客戶主檔一致，會用於檔名與客戶畫面。');
    var folder = field(m, '公司資料夾網址（可稍後設定）', el('input', { type: 'text', placeholder: 'https://drive.google.com/drive/folders/…' }));
    modalActions(m, '建立', function (fail) {
      call('createCompany', { companyId: id.value.trim(), name: name.value, folder: folder.value.trim() },
        function () { closeModal(); loadCompanies(); }, function (e) { fail(e.message); });
    });
  };

  function renameCompanyDialog(c) {
    var m = openModal('修改公司名稱');
    m.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px' }, '統一編號 ' + c.companyId + '。改名不會回溯修改已歸檔的檔名。'));
    var name = field(m, '公司全名', el('input', { type: 'text' }));
    name.value = c.name;
    modalActions(m, '儲存', function (fail) {
      call('renameCompany', { companyId: c.companyId, name: name.value }, function () { closeModal(); loadCompanies(); }, function (e) { fail(e.message); });
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
  $('overlay').onclick = function (e) { if (e.target === $('overlay')) closeModal(); };

  function enter(notice) {
    showBusy('載入中…');
    call('getHome', {}, function (home) { hideBusy(); showApp(home); if (notice) alert(notice); },
      function (err) { hideBusy(); showLogin(err.message, notice); });
  }

  (function start() {
    // LINE Login 回到本頁：以 code／state 向後端換取登入
    if (params.get('code') || params.get('error')) {
      var args = { code: params.get('code') || '', state: params.get('state') || '', error: params.get('error') || '' };
      cleanUrl();
      showBusy('登入中，請稍候…');
      api('callback', args).then(function (r) {
        hideBusy();
        if (r.sessionToken) {
          token = r.sessionToken; store(TOKEN_KEY, token);
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
    enter('');
  })();
})();
