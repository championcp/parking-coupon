/* ═══════════════════════════════════════════════
   Index Page Logic
   ═══════════════════════════════════════════════ */

import { showToast } from './toast.js';
import { api, setCsrfToken } from './api.js';

const $ = (id) => document.getElementById(id);
const statsSection = $('statsSection');
const navUser = $('navUser');
const navUsername = $('navUsername');

async function init() {
  try {
    const session = await api('/api/admin/session');
    setCsrfToken(session.csrfToken || '');

    // Show user info in nav
    if (navUser) navUser.style.display = 'flex';
    if (navUsername) navUsername.textContent = session.username || 'admin';

    // Load dashboard stats
    if (statsSection) {
      const stats = await api('/api/admin/stats');
      statsSection.style.display = 'block';
      if ($('statTotal')) $('statTotal').textContent = String(stats.totalVouchers || 0);
      if ($('statActive')) $('statActive').textContent = String(stats.activeVouchers || 0);
      if ($('statTodayCreated')) $('statTodayCreated').textContent = String(stats.todayCreated || 0);
      if ($('statTodayUsed')) $('statTodayUsed').textContent = String(stats.todayUsed || 0);
      if ($('statTotalIssued')) $('statTotalIssued').textContent = String(stats.totalIssued || 0);
      if ($('statTotalUsed')) $('statTotalUsed').textContent = String(stats.totalUsed || 0);
      if ($('statTotalRemain')) $('statTotalRemain').textContent = String(stats.totalRemain || 0);
    }
  } catch {
    // Not logged in — show landing page only
  }
}

// Nav logout
if ($('navLogout')) {
  $('navLogout').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ok */ }
    if (navUser) navUser.style.display = 'none';
    if (statsSection) statsSection.style.display = 'none';
    showToast('已退出登录', 'info');
  });
}

init();
