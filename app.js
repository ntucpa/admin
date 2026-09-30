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
  var READ_ONLY = { ping: 1, loginUrl: 1, getHome: 1, getSettings: 1, listCompanies: 1, getUnclassifiedFolder: 1, listAdmins: 1, checkEmail: 1 };
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
    renderHome(home);
  }

  /* ---------- 首頁 ---------- */
  function renderHome(home) {
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

  function renderAdmins(d) {
    var box = $('adminBox'); box.innerHTML = '';
    var names = {}; d.companies.forEach(function (c) { names[c.companyId] = c.name; });
    var t = el('table');
    var cg = el('colgroup'); ['170px', '', '', '120px', '130px'].forEach(function (w) { cg.appendChild(el('col', w ? { style: 'width:' + w } : {})); }); t.appendChild(cg);
    var h = el('tr'); ['姓名／角色', 'Google 帳號', '負責公司', '雲端權限', '操作'].forEach(function (x) { h.appendChild(el('th', {}, x)); }); t.appendChild(h);
    d.admins.forEach(function (a) {
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
  document.querySelectorAll('nav a[data-page]').forEach(function (a) { a.onclick = function () { go(a.getAttribute('data-page')); }; });
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
