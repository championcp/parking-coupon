/* ───── Shared Utility Functions ───── */

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function toDisplayTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN');
}

export function toDisplayDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('zh-CN');
}

export function statusBadge(status) {
  if (status === 'disabled') return { cls: 'badge badge-danger', text: '已停用' };
  return { cls: 'badge badge-ok', text: '活跃' };
}

export function warningBadge(remain) {
  const r = Number(remain);
  if (!Number.isFinite(r) || r < 0) return null;
  if (r <= 3) return { cls: 'badge badge-danger', text: '紧急' };
  if (r <= 10) return { cls: 'badge badge-warn', text: '预警' };
  return null;
}

export function safeNextPath(raw) {
  if (!raw) return '';
  if (!raw.startsWith('/')) return '';
  if (raw.startsWith('//')) return '';
  return raw;
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

export function logTypeName(type) {
  const map = {
    ADMIN_LOGIN: '管理员登录',
    ADMIN_LOGOUT: '管理员登出',
    CREATE: '录入购买',
    WEBHOOK_USE: '物业API回调',
    MANUAL_USE: '手动记录使用',
    CONFIRM: '确认使用',
    ADJUST: '修正次数',
    UPDATE: '更新记录',
    DISABLE: '停用',
    DISPLAY: '展码',
    // Legacy types (for old log entries)
    IMPORT: '导入停车券',
    MARK_USED: '标记已使用',
    UPLOAD_QR: '上传二维码',
  };
  return map[type] || type;
}

export function sourceLabel(source) {
  if (source === 'api') return { cls: 'badge badge-teal', text: '物业API' };
  if (source === 'manual') return { cls: 'badge badge-warn', text: '手动录入' };
  return { cls: 'badge badge-light', text: source || '未知' };
}

export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadImageFromSrc(imgSrc, filename) {
  const a = document.createElement('a');
  a.href = imgSrc;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
