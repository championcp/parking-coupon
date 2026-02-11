/* ───── Unified API Wrapper ───── */

let csrfToken = '';

export function setCsrfToken(token) {
  csrfToken = token || '';
}

export function getCsrfToken() {
  return csrfToken;
}

/**
 * Make an API request with automatic CSRF and credential handling.
 * Dispatches a 'session-expired' CustomEvent on 401 responses.
 *
 * @param {string} url - The API endpoint
 * @param {object} options - { method, body, headers }
 * @returns {Promise<any>} Parsed JSON response
 * @throws {{ status: number, data: any }} On non-OK responses
 */
export async function api(url, options = {}) {
  const { method = 'GET', body, headers = {} } = options;

  const fetchOpts = {
    method,
    credentials: 'same-origin',
    headers: { ...headers },
  };

  if (body !== undefined) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(body);
  }

  // Attach CSRF token for state-changing methods
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    fetchOpts.headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(url, fetchOpts);

  let data;
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('session-expired'));
    }
    const err = new Error(data?.message || data?.error || 'Request failed');
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}
