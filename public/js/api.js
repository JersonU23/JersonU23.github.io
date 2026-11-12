// Cliente de la API. Usa la cookie de sesión httpOnly; la cabecera X-Requested-With protege contra CSRF.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Error ${status}`);
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
  }
}

async function request(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'fetch', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401 && !url.startsWith('/auth/login')) window.dispatchEvent(new Event('fai:unauthorized'));
  if (!res.ok) throw new ApiError(res.status, isJson ? data : { error: data });
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del: (u, b = {}) => request('DELETE', u, b),
};

// Descarga autenticada (CSV/JSON) respetando la cookie de sesión
export async function download(url, filename) {
  const res = await fetch(`/api${url}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
