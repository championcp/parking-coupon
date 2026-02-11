/* ═══════════════════════════════════════════════
   Admin System — Parking Coupon Tracking (物业API对接版)
   ═══════════════════════════════════════════════ */

import { escapeHtml, toDisplayTime, statusBadge, warningBadge, safeNextPath, logTypeName, sourceLabel } from './utils.js';
import { showToast } from './toast.js';
import { api, setCsrfToken, getCsrfToken } from './api.js';

/* ───── DOM refs ───── */
const $ = (id) => document.getElementById(id);

const loginScreen = $('loginScreen');
const appShell = $('appShell');
const sidebar = $('sidebar');
const sidebarOverlay = $('sidebarOverlay');
const detailModal = $('detailModal');
const pageTitle = $('pageTitle');

const usernameInput = $('username');
const passwordInput = $('password');
const loginBtn = $('loginBtn');

const historySearchInput = $('historySearchInput');
const historyStatusFilter = $('historyStatusFilter');
const historyPageSize = $('historyPageSize');
const historyTableBody = $('historyTableBody');
const historyCardList = $('historyCardList');
const historyPrevBtn = $('historyPrevBtn');
const historyNextBtn = $('historyNextBtn');
const historyPageInfo = $('historyPageInfo');

const createFileInput = $('createFileInput');
const uploadArea = $('uploadArea');
const createBtn = $('createBtn');
const createTotal = $('createTotal');
const createNote = $('createNote');
const createResultCard = $('createResultCard');

const nextAfterLogin = safeNextPath(new URLSearchParams(location.search).get('next') || '');

/* ───── State ───── */
let currentTab = 'overview';
const historyState = { page: 1, pageSize: 10, q: '', status: '', totalPages: 1 };
const logState = { page: 1, pageSize: 20, totalPages: 1 };
const usageState = { page: 1, pageSize: 20, totalPages: 1, startDate: '', endDate: '' };
let selectedFile = null;

const PAGE_TITLES = {
  overview: '仪表盘',
  create: '录入购买',
  usages: '使用记录',
  history: '券管理',
  logs: '操作日志',
};

/* ═══════════════════════════════════════════════
   Sidebar Navigation & Tab Switching
   ═══════════════════════════════════════════════ */

function switchTab(tabName) {
  currentTab = tabName;

  document.querySelectorAll('.sidebar-item[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab${capitalize(tabName)}`);
  });

  pageTitle.textContent = PAGE_TITLES[tabName] || tabName;

  if (location.hash !== `#${tabName}`) {
    history.replaceState(null, '', `#${tabName}`);
  }

  closeSidebar();

  if (tabName === 'overview') loadStats();
  if (tabName === 'history') loadHistory();
  if (tabName === 'usages') loadUsages();
  if (tabName === 'logs') loadLogs();
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

document.querySelectorAll('.sidebar-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.querySelectorAll('[data-goto-tab]').forEach(el => {
  el.addEventListener('click', () => switchTab(el.dataset.gotoTab));
});

function checkHash() {
  const hash = location.hash.replace('#', '');
  if (['overview', 'create', 'usages', 'history', 'logs'].includes(hash)) {
    switchTab(hash);
  }
}

window.addEventListener('hashchange', checkHash);

/* ═══════════════════════════════════════════════
   Mobile Sidebar
   ═══════════════════════════════════════════════ */

function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('visible');
  document.body.style.overflow = '';
}

$('hamburgerBtn').addEventListener('click', openSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

/* ═══════════════════════════════════════════════
   Session / Auth
   ═══════════════════════════════════════════════ */

window.addEventListener('session-expired', () => {
  setLoggedOut();
  showToast('登录已失效，请重新登录', 'error');
});

function setLoggedIn(name) {
  loginScreen.style.display = 'none';
  appShell.style.display = 'flex';
  $('sidebarUsername').textContent = name;
  $('sidebarAvatar').textContent = (name || 'Q')[0].toUpperCase();
  checkHash();
  switchTab(currentTab);
}

function setLoggedOut() {
  loginScreen.style.display = 'flex';
  appShell.style.display = 'none';
  historyTableBody.innerHTML = '';
  if (historyCardList) historyCardList.innerHTML = '';
  historyPageInfo.textContent = '第 1 / 1 页';
  setCsrfToken('');
  closeSidebar();
}

async function checkSession() {
  try {
    const d = await api('/api/admin/session');
    setCsrfToken(d.csrfToken || '');
    if (nextAfterLogin) { location.href = nextAfterLogin; return; }
    setLoggedIn(d.username || 'qzadmin');
  } catch {
    setLoggedOut();
  }
}

async function login() {
  loginBtn.disabled = true;
  try {
    const d = await api('/api/admin/login', {
      method: 'POST',
      body: { username: usernameInput.value.trim(), password: passwordInput.value },
    });
    setCsrfToken(d.csrfToken || '');
    if (nextAfterLogin) { location.href = nextAfterLogin; return; }
    setLoggedIn(d.username);
    showToast('登录成功');
    passwordInput.value = '';
  } catch (err) {
    showToast(err.data?.message || '登录失败', 'error');
  } finally {
    loginBtn.disabled = false;
  }
}

async function logout() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ok */ }
  setLoggedOut();
  showToast('已退出登录', 'info');
}

/* ═══════════════════════════════════════════════
   Dashboard Stats (enhanced)
   ═══════════════════════════════════════════════ */

async function loadStats() {
  try {
    const s = await api('/api/admin/stats');
    $('statRecords').textContent = String(s.totalVouchers || 0);
    $('statTotalIssued').textContent = String(s.totalIssued || 0);
    $('statUsed').textContent = String(s.totalUsed || 0);
    $('statRemain').textContent = String(s.totalRemain || 0);
    $('statTodayUsed').textContent = String(s.todayUsed || 0);
    $('statMonthUsed').textContent = String(s.thisMonthUsed || 0);
    $('statYearUsed').textContent = String(s.thisYearUsed || 0);
    $('statDisabled').textContent = String(s.disabledVouchers || 0);

    // Render 7-day trend chart
    renderTrendChart(s.recentDays || []);
  } catch { /* silent */ }
}

function renderTrendChart(days) {
  const container = $('trendChart');
  if (!container || !days.length) {
    if (container) container.innerHTML = '<span class="muted">暂无数据</span>';
    return;
  }

  const maxVal = Math.max(...days.map(d => d.count), 1);

  container.innerHTML = days.map(d => {
    const pct = Math.max(4, Math.round((d.count / maxVal) * 100));
    const dayLabel = d.date.slice(5); // MM-DD
    const weekDay = ['日', '一', '二', '三', '四', '五', '六'][new Date(d.date + 'T00:00:00').getDay()];
    return `<div class="trend-bar-wrap">
      <div class="trend-count">${d.count}</div>
      <div class="trend-bar" style="height:${pct}%"></div>
      <div class="trend-label">${dayLabel}</div>
      <div class="trend-label-sub">周${weekDay}</div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   Create Purchase Record (录入购买)
   ═══════════════════════════════════════════════ */

function updateFilePreview() {
  const preview = $('filePreview');
  const nameEl = $('filePreviewName');
  if (selectedFile) {
    preview.style.display = 'flex';
    nameEl.textContent = `${selectedFile.name} (${(selectedFile.size / 1024).toFixed(0)} KB)`;
  } else {
    preview.style.display = 'none';
    nameEl.textContent = '';
  }
  updateCreateBtn();
}

function updateCreateBtn() {
  const total = Number(createTotal.value);
  createBtn.disabled = !(selectedFile && total > 0);
}

uploadArea.addEventListener('click', () => createFileInput.click());

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (files.length) {
    selectedFile = files[0];
    updateFilePreview();
  }
});

createFileInput.addEventListener('change', () => {
  const files = Array.from(createFileInput.files || []);
  if (files.length) {
    selectedFile = files[0];
    updateFilePreview();
  }
  createFileInput.value = '';
});

$('filePreviewRemove').addEventListener('click', () => {
  selectedFile = null;
  updateFilePreview();
});

createTotal.addEventListener('input', updateCreateBtn);

async function createPurchaseRecord() {
  const total = Number(createTotal.value);
  if (!selectedFile || total <= 0) {
    showToast('请填写购买次数并选择二维码图片', 'error');
    return;
  }

  createBtn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('qrImage', selectedFile);
    formData.append('total', String(Math.trunc(total)));
    const note = createNote.value.trim();
    if (note) formData.append('note', note);

    const response = await fetch('/api/admin/voucher', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': getCsrfToken() },
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) throw { data };

    selectedFile = null;
    updateFilePreview();
    createTotal.value = '';
    createNote.value = '';
    updateCreateBtn();
    createResultCard.style.display = 'block';
    $('createResultText').textContent = `成功录入购买记录 ${data.voucher?.id || ''}，共 ${total} 次`;
    showToast(`成功录入 ${total} 次停车券`);
  } catch (err) {
    showToast(err?.data?.message || '录入失败', 'error');
  } finally {
    createBtn.disabled = false;
  }
}

createBtn.addEventListener('click', createPurchaseRecord);

/* ═══════════════════════════════════════════════
   Usage Records (使用记录)
   ═══════════════════════════════════════════════ */

function getDateRange(range) {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;

  switch (range) {
    case 'today':
      return { startDate: todayStr, endDate: todayStr };
    case 'week': {
      const weekStart = new Date(today);
      const day = weekStart.getDay();
      const diff = day === 0 ? 6 : day - 1; // Monday as first day
      weekStart.setDate(weekStart.getDate() - diff);
      const ws = weekStart.toISOString().slice(0, 10);
      return { startDate: ws, endDate: todayStr };
    }
    case 'month':
      return { startDate: `${y}-${m}-01`, endDate: todayStr };
    case 'year':
      return { startDate: `${y}-01-01`, endDate: todayStr };
    case 'all':
      return { startDate: '', endDate: '' };
    default:
      return { startDate: todayStr, endDate: todayStr };
  }
}

function setUsageDateRange(range) {
  const { startDate, endDate } = getDateRange(range);
  usageState.startDate = startDate;
  usageState.endDate = endDate;
  $('usageStartDate').value = startDate;
  $('usageEndDate').value = endDate;

  // Update active class on shortcuts
  document.querySelectorAll('.date-shortcut').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
}

function renderUsages(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const pg = data.pagination || {};
  const summary = data.summary || {};

  $('usageSumTotal').textContent = String(summary.totalUsages || 0);

  const usageTableBody = $('usageTableBody');
  const usageCardList = $('usageCardList');

  if (!items.length) {
    usageTableBody.innerHTML = '<tr><td colspan="3" class="muted text-center" style="padding:24px">暂无使用记录</td></tr>';
  } else {
    usageTableBody.innerHTML = items.map(u => {
      const srcBadge = sourceLabel(u.source);
      return `<tr>
        <td>${escapeHtml(toDisplayTime(u.usedAt))}</td>
        <td class="mono">${escapeHtml(u.voucherId || '-')}</td>
        <td><span class="${srcBadge.cls}">${srcBadge.text}</span></td>
      </tr>`;
    }).join('');
  }

  if (usageCardList) {
    if (!items.length) {
      usageCardList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><h4>暂无使用记录</h4></div>';
    } else {
      usageCardList.innerHTML = items.map(u => {
        const srcBadge = sourceLabel(u.source);
        return `<div class="voucher-card">
          <div class="voucher-card-header">
            <span style="font-size:12px;color:var(--muted)">${escapeHtml(toDisplayTime(u.usedAt))}</span>
            <span class="${srcBadge.cls}">${srcBadge.text}</span>
          </div>
          <div class="mono" style="font-size:12px;margin-top:4px">${escapeHtml(u.voucherId || '-')}</div>
        </div>`;
      }).join('');
    }
  }

  usageState.page = Number(pg.page || 1);
  usageState.totalPages = Number(pg.totalPages || 1);
  $('usagePageInfo').textContent = `第 ${usageState.page} / ${usageState.totalPages} 页，共 ${pg.total || 0} 条`;
  $('usagePrevBtn').disabled = !pg.hasPrev;
  $('usageNextBtn').disabled = !pg.hasNext;
}

async function loadUsages(options = {}) {
  if (options.resetPage) usageState.page = 1;
  const params = new URLSearchParams({
    page: String(usageState.page),
    pageSize: String(usageState.pageSize),
  });
  if (usageState.startDate) params.set('startDate', usageState.startDate);
  if (usageState.endDate) params.set('endDate', usageState.endDate);

  try {
    const d = await api('/api/admin/usages?' + params.toString());
    renderUsages(d);
  } catch {
    showToast('加载使用记录失败', 'error');
  }
}

// Date shortcut buttons
document.querySelectorAll('.date-shortcut').forEach(btn => {
  btn.addEventListener('click', () => {
    setUsageDateRange(btn.dataset.range);
    loadUsages({ resetPage: true });
  });
});

// Query button
$('usageQueryBtn').addEventListener('click', () => {
  usageState.startDate = $('usageStartDate').value;
  usageState.endDate = $('usageEndDate').value;
  document.querySelectorAll('.date-shortcut').forEach(b => b.classList.remove('active'));
  loadUsages({ resetPage: true });
});

// Usage export
$('usageExportBtn').addEventListener('click', () => {
  const params = new URLSearchParams();
  if (usageState.startDate) params.set('startDate', usageState.startDate);
  if (usageState.endDate) params.set('endDate', usageState.endDate);
  window.open('/api/admin/usages/export?' + params.toString(), '_blank');
});

// Usage pagination
$('usagePrevBtn').addEventListener('click', () => { usageState.page = Math.max(1, usageState.page - 1); loadUsages(); });
$('usageNextBtn').addEventListener('click', () => { usageState.page = Math.min(usageState.totalPages, usageState.page + 1); loadUsages(); });

// Init usage date range to today
setUsageDateRange('today');

/* ═══════════════════════════════════════════════
   History (Voucher List)
   ═══════════════════════════════════════════════ */

function renderHistory(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const pg = data.pagination || {};
  const summary = data.summary || {};

  $('sumIssued').textContent = String(summary.totalIssued || 0);
  $('sumUsed').textContent = String(summary.totalUsed || 0);
  $('sumRemain').textContent = String(summary.totalRemain || 0);

  if (!items.length) {
    historyTableBody.innerHTML = '<tr><td colspan="7" class="muted text-center" style="padding:24px">暂无购买记录</td></tr>';
  } else {
    historyTableBody.innerHTML = items.map((item) => {
      const stBadge = statusBadge(item.status);
      const wBadge = warningBadge(item.remain);
      const rowCls = item.status === 'disabled' ? 'row-disabled' : '';
      return `<tr class="${rowCls}">
        <td class="mono">${escapeHtml(item.id || '-')}</td>
        <td>${item.total}</td>
        <td>${item.used}</td>
        <td>${item.remain}${wBadge ? ` <span class="${wBadge.cls}">${wBadge.text}</span>` : ''}</td>
        <td><span class="${stBadge.cls}">${stBadge.text}</span></td>
        <td>${escapeHtml((item.note || '').slice(0, 20))}</td>
        <td>
          <div class="actions">
            <button class="btn btn-secondary btn-xs" type="button" data-detail-voucher="${escapeHtml(item.id)}">详情</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  if (historyCardList) {
    if (!items.length) {
      historyCardList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><h4>暂无购买记录</h4></div>';
    } else {
      historyCardList.innerHTML = items.map((item) => {
        const stBadge = statusBadge(item.status);
        const wBadge = warningBadge(item.remain);
        return `<div class="voucher-card">
          <div class="voucher-card-header">
            <span class="mono">${escapeHtml(item.id)}</span>
            <span class="${stBadge.cls}">${stBadge.text}</span>
          </div>
          <div class="voucher-card-body">
            <div><div class="vc-label">购买</div><div class="vc-value">${item.total}</div></div>
            <div><div class="vc-label">已用</div><div class="vc-value">${item.used}</div></div>
            <div><div class="vc-label">剩余</div><div class="vc-value">${item.remain}${wBadge ? ` <span class="${wBadge.cls}" style="font-size:10px">${wBadge.text}</span>` : ''}</div></div>
          </div>
          ${item.note ? `<div class="voucher-card-note">${escapeHtml(item.note)}</div>` : ''}
          <div class="voucher-card-footer">
            <button class="btn btn-secondary btn-xs" type="button" data-detail-voucher="${escapeHtml(item.id)}">详情</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  historyState.page = Number(pg.page || 1);
  historyState.totalPages = Number(pg.totalPages || 1);
  historyPageInfo.textContent = `第 ${historyState.page} / ${historyState.totalPages} 页，共 ${pg.total || 0} 条`;
  historyPrevBtn.disabled = !pg.hasPrev;
  historyNextBtn.disabled = !pg.hasNext;
}

async function loadHistory(options = {}) {
  if (options.resetPage) historyState.page = 1;
  const params = new URLSearchParams({
    page: String(historyState.page),
    pageSize: String(historyState.pageSize),
  });
  if (historyState.q) params.set('q', historyState.q);
  if (historyState.status) params.set('status', historyState.status);
  try {
    const d = await api('/api/admin/vouchers?' + params.toString());
    renderHistory(d);
  } catch {
    showToast('加载列表失败', 'error');
  }
}

/* ═══════════════════════════════════════════════
   Logs
   ═══════════════════════════════════════════════ */

function metaToString(meta) {
  if (!meta || typeof meta !== 'object') return '-';
  const parts = [];
  if (meta.admin) parts.push(`操作人:${meta.admin}`);
  if (meta.username) parts.push(`用户:${meta.username}`);
  if (meta.total) parts.push(`次数:${meta.total}`);
  if (meta.usageId) parts.push(`使用ID:${meta.usageId}`);
  if (meta.source) parts.push(`来源:${meta.source === 'api' ? '物业API' : '手动'}`);
  if (meta.before !== undefined && meta.after !== undefined) parts.push(`${meta.before}→${meta.after}`);
  if (meta.oldRemain !== undefined && meta.newRemain !== undefined) parts.push(`修正:${meta.oldRemain}→${meta.newRemain}`);
  if (meta.note) parts.push(meta.note);
  return parts.length ? parts.join(', ') : '-';
}

async function loadLogs() {
  const params = new URLSearchParams({
    page: String(logState.page),
    pageSize: String(logState.pageSize),
  });
  const typeVal = $('logTypeFilter')?.value;
  const voucherVal = ($('logVoucherFilter')?.value || '').trim();
  if (typeVal) params.set('type', typeVal);
  if (voucherVal) params.set('voucherId', voucherVal);

  try {
    const d = await api('/api/admin/logs?' + params.toString());
    const items = d.items || [];
    const pg = d.pagination || {};
    const logTableBody = $('logTableBody');
    const logCardList = $('logCardList');

    if (!items.length) {
      logTableBody.innerHTML = '<tr><td colspan="5" class="muted text-center" style="padding:24px">暂无日志记录</td></tr>';
    } else {
      logTableBody.innerHTML = items.map(l => `<tr>
        <td>${escapeHtml(toDisplayTime(l.ts))}</td>
        <td><span class="log-type-badge log-type-${l.type || ''}">${escapeHtml(logTypeName(l.type))}</span></td>
        <td class="mono">${escapeHtml(l.voucherId || '-')}</td>
        <td style="font-size:12px">${escapeHtml(l.ip || '-')}</td>
        <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(metaToString(l.meta))}</td>
      </tr>`).join('');
    }

    if (logCardList) {
      if (!items.length) {
        logCardList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><h4>暂无日志</h4></div>';
      } else {
        logCardList.innerHTML = items.map(l => `<div class="voucher-card">
          <div class="voucher-card-header">
            <span class="log-type-badge log-type-${l.type || ''}">${escapeHtml(logTypeName(l.type))}</span>
            <span style="font-size:12px;color:var(--muted)">${escapeHtml(toDisplayTime(l.ts))}</span>
          </div>
          ${l.voucherId ? `<div class="mono" style="font-size:12px;margin-bottom:4px">${escapeHtml(l.voucherId)}</div>` : ''}
          <div style="font-size:12px;color:var(--muted)">${escapeHtml(metaToString(l.meta))}</div>
        </div>`).join('');
      }
    }

    logState.page = pg.page || 1;
    logState.totalPages = pg.totalPages || 1;
    $('logPageInfo').textContent = `第 ${logState.page} / ${logState.totalPages} 页，共 ${pg.total || 0} 条`;
    $('logPrevBtn').disabled = !pg.hasPrev;
    $('logNextBtn').disabled = !pg.hasNext;
  } catch {
    showToast('加载日志失败', 'error');
  }
}

/* ═══════════════════════════════════════════════
   Voucher Detail Modal
   ═══════════════════════════════════════════════ */

async function showDetailModal(voucherId) {
  try {
    const d = await api(`/api/admin/voucher/${encodeURIComponent(voucherId)}`);
    const v = d.voucher;
    const stBadge = statusBadge(v.status);
    const t = Number(v.total) || 0;
    const r = Number(v.remain) || 0;
    const used = Math.max(0, t - r);
    const wBadge = warningBadge(r);
    const pct = t > 0 ? Math.round(((t - r) / t) * 100) : 0;

    $('modalTitle').textContent = `购买记录 — ${v.id}`;

    let logsHtml = '';
    if (d.logs && d.logs.length > 0) {
      logsHtml = '<h4 style="margin:16px 0 8px">操作记录</h4><div class="timeline">' +
        d.logs.map(l => {
          const dotCls = l.type === 'WEBHOOK_USE' ? 'dot-confirm' : l.type === 'MANUAL_USE' ? 'dot-confirm' : l.type === 'CREATE' ? 'dot-create' : l.type === 'ADJUST' ? 'dot-upload' : 'dot-other';
          return `<div class="timeline-item"><div class="timeline-dot ${dotCls}"></div>
            <div class="timeline-desc">${escapeHtml(logTypeName(l.type))}</div>
            <div class="timeline-time">${escapeHtml(toDisplayTime(l.ts))}</div>
          </div>`;
        }).join('') + '</div>';
    }

    $('modalBody').innerHTML = `
      <div class="kv">
        <div class="kv-item"><span class="muted">记录号</span><b class="mono">${escapeHtml(v.id)}</b></div>
        <div class="kv-item"><span class="muted">状态</span><span class="${stBadge.cls}">${stBadge.text}</span></div>
        <div class="kv-item"><span class="muted">购买次数</span><b>${t}</b></div>
        <div class="kv-item"><span class="muted">已用次数</span><b>${used}</b></div>
        <div class="kv-item"><span class="muted">剩余次数</span><b>${r}</b>${wBadge ? ` <span class="${wBadge.cls}">${wBadge.text}</span>` : ''}</div>
        <div class="kv-item"><span class="muted">使用进度</span><span>${pct}%</span></div>
        <div class="kv-item"><span class="muted">创建时间</span><span>${escapeHtml(toDisplayTime(v.createdAt))}</span></div>
        ${v.lastUsedAt ? `<div class="kv-item"><span class="muted">最后使用</span><span>${escapeHtml(toDisplayTime(v.lastUsedAt))}</span></div>` : ''}
        ${v.note ? `<div class="kv-item"><span class="muted">备注</span><span>${escapeHtml(v.note)}</span></div>` : ''}
      </div>
      <div class="progress" style="margin:12px 0"><span style="width:${pct}%"></span></div>
      ${d.qrDataUrl ? `<div class="qr-wrap" style="margin-top:16px"><img src="${d.qrDataUrl}" alt="QR"/></div>` : ''}

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
        <h4 style="margin:0 0 8px">修正剩余次数（对账）</h4>
        <p class="muted" style="font-size:12px;margin:0 0 8px">与物业核对后，可在此修正实际剩余次数</p>
        <div style="display:flex;gap:8px;align-items:center;max-width:300px">
          <input id="adjustRemainInput" type="number" min="0" value="${r}" style="flex:1"/>
          <button class="btn btn-secondary btn-sm" id="adjustRemainBtn" type="button">修正</button>
        </div>
      </div>

      ${logsHtml}
    `;

    // Adjust remain handler
    $('adjustRemainBtn').addEventListener('click', async () => {
      const newRemain = Number($('adjustRemainInput').value);
      if (!Number.isFinite(newRemain) || newRemain < 0) {
        showToast('请输入有效的剩余次数', 'error');
        return;
      }
      try {
        await api(`/api/admin/voucher/${encodeURIComponent(voucherId)}`, {
          method: 'PUT',
          body: { remain: newRemain },
        });
        showToast(`剩余次数已修正为 ${newRemain}`);
        closeModal();
        await loadHistory();
      } catch (err) {
        showToast(err.data?.message || '修正失败', 'error');
      }
    });

    // Simulate use button (模拟物业回调)
    const simulateBtn = $('modalSimulateUse');
    if (v.status === 'active' && r > 0) {
      simulateBtn.style.display = '';
      simulateBtn.onclick = async () => {
        if (!confirm('确认模拟使用一次？（模拟物业系统回调）')) return;
        try {
          const result = await api(`/api/admin/voucher/${encodeURIComponent(voucherId)}/use`, { method: 'POST' });
          showToast(`模拟使用成功，剩余 ${result.remain} 次`);
          closeModal();
          await loadHistory();
        } catch (err) {
          showToast(err.data?.message || '模拟使用失败', 'error');
        }
      };
    } else {
      simulateBtn.style.display = 'none';
    }

    // Disable/Enable button
    const disableBtn = $('modalDisable');
    disableBtn.onclick = () => disableVoucher(voucherId);
    disableBtn.textContent = v.status === 'disabled' ? '启用' : '停用';
    disableBtn.className = v.status === 'disabled' ? 'btn btn-secondary btn-sm' : 'btn btn-danger btn-sm';

    detailModal.style.display = 'flex';
  } catch (err) {
    showToast(err.data?.message || '加载详情失败', 'error');
  }
}

function closeModal() { detailModal.style.display = 'none'; }

async function disableVoucher(voucherId) {
  const disableBtn = $('modalDisable');
  const isCurrentlyDisabled = disableBtn.textContent === '启用';
  if (!isCurrentlyDisabled && !confirm('确定要停用此购买记录吗？')) return;
  try {
    if (isCurrentlyDisabled) {
      await api(`/api/admin/voucher/${encodeURIComponent(voucherId)}`, { method: 'PUT', body: { status: 'active' } });
      showToast('已启用');
    } else {
      await api(`/api/admin/voucher/${encodeURIComponent(voucherId)}`, { method: 'DELETE' });
      showToast('已停用');
    }
    closeModal();
    await loadHistory();
  } catch (err) {
    showToast(err.data?.message || '操作失败', 'error');
  }
}

/* ═══════════════════════════════════════════════
   Event Listeners
   ═══════════════════════════════════════════════ */

$('loginForm').addEventListener('submit', (e) => { e.preventDefault(); login(); });
$('navLogout').addEventListener('click', logout);

function exportCsv() { window.open('/api/admin/export', '_blank'); }
$('exportCsvBtn').addEventListener('click', exportCsv);

// History controls
$('refreshHistoryBtn').addEventListener('click', () => loadHistory());
$('historySearchBtn').addEventListener('click', () => {
  historyState.q = historySearchInput.value.trim();
  historyState.status = historyStatusFilter.value;
  loadHistory({ resetPage: true });
});
historySearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    historyState.q = historySearchInput.value.trim();
    historyState.status = historyStatusFilter.value;
    loadHistory({ resetPage: true });
  }
});
historyStatusFilter.addEventListener('change', () => {
  historyState.status = historyStatusFilter.value;
  loadHistory({ resetPage: true });
});
historyPageSize.addEventListener('change', () => {
  historyState.pageSize = Number(historyPageSize.value) || 10;
  loadHistory({ resetPage: true });
});
historyPrevBtn.addEventListener('click', () => { historyState.page = Math.max(1, historyState.page - 1); loadHistory(); });
historyNextBtn.addEventListener('click', () => { historyState.page = Math.min(historyState.totalPages, historyState.page + 1); loadHistory(); });

// History delegation (table + card list)
historyTableBody.addEventListener('click', (e) => {
  const detailBtn = e.target instanceof HTMLElement ? e.target.closest('[data-detail-voucher]') : null;
  if (detailBtn) showDetailModal(detailBtn.getAttribute('data-detail-voucher') || '');
});
if (historyCardList) {
  historyCardList.addEventListener('click', (e) => {
    const detailBtn = e.target instanceof HTMLElement ? e.target.closest('[data-detail-voucher]') : null;
    if (detailBtn) showDetailModal(detailBtn.getAttribute('data-detail-voucher') || '');
  });
}

// Log controls
$('logSearchBtn').addEventListener('click', () => { logState.page = 1; loadLogs(); });
$('logRefreshBtn').addEventListener('click', () => loadLogs());
$('logTypeFilter').addEventListener('change', () => { logState.page = 1; loadLogs(); });
$('logVoucherFilter').addEventListener('keydown', (e) => { if (e.key === 'Enter') { logState.page = 1; loadLogs(); } });
$('logPrevBtn').addEventListener('click', () => { logState.page = Math.max(1, logState.page - 1); loadLogs(); });
$('logNextBtn').addEventListener('click', () => { logState.page = Math.min(logState.totalPages, logState.page + 1); loadLogs(); });

// Modal
$('modalClose').addEventListener('click', closeModal);
detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailModal.style.display !== 'none') closeModal(); });

/* ───── Init ───── */
checkSession();
