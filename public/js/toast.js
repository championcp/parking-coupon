/* ───── Toast Notification System ───── */

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.id = 'toast-container';
  document.body.appendChild(container);
  return container;
}

/**
 * Show a toast notification.
 * @param {string} message - The message to display
 * @param {'success'|'error'|'info'} type - Toast type
 * @param {number} duration - Duration in ms before auto-dismiss
 */
export function showToast(message, type = 'success', duration = 3000) {
  const c = ensureContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'error' ? '✕' : type === 'info' ? 'ℹ' : '✓'}</span>
    <span class="toast-text">${message}</span>
  `;
  c.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast-show');
  });

  const timer = setTimeout(() => dismiss(), duration);

  toast.addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
  });

  function dismiss() {
    toast.classList.remove('toast-show');
    toast.classList.add('toast-hide');
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 300);
  }
}
