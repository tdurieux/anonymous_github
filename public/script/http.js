// Keep response metadata alongside parsed data for the existing API consumers.
export function createHttp(fetcher = (...args) => fetch(...args)) {
  async function request(method, url, data, options = {}) {
    const target = new URL(url, window.location.href);
    for (const [key, value] of Object.entries(options.params || {})) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) target.searchParams.append(key, typeof item === "object" ? JSON.stringify(item) : item);
    }
    const controller = new AbortController();
    let timer;
    if (options.timeout?.then) options.timeout.then(() => controller.abort());
    else if (options.timeout) timer = setTimeout(() => controller.abort(), options.timeout);
    try {
      const headers = { Accept: "application/json, text/plain, */*", ...options.headers };
      const csrf = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
      if (csrf && target.origin === window.location.origin) headers["X-XSRF-TOKEN"] = decodeURIComponent(csrf[1]);
      let body;
      if (data !== undefined) {
        if (data instanceof FormData) body = data;
        else { headers["Content-Type"] ||= "application/json;charset=utf-8"; body = JSON.stringify(data); }
      }
      const response = await fetcher(target.href, { method, headers, body, credentials: "same-origin", signal: controller.signal });
      const raw = await response.text();
      let result = raw;
      if (options.transformResponse) result = options.transformResponse(raw);
      else if (raw && (/json/i.test(response.headers.get("content-type") || "") || /^[\[{]/.test(raw.trim()))) {
        try { result = JSON.parse(raw); } catch { /* File content may start with a brace. */ }
      }
      const value = { data: result, status: response.status, headers: name => response.headers.get(name) };
      if (!response.ok) throw value;
      return value;
    } catch (error) {
      if (error.name === "AbortError") throw { status: -1, data: null };
      throw error;
    } finally { clearTimeout(timer); }
  }
  const http = {};
  for (const method of ["get", "delete", "head"]) http[method] = (url, options) => request(method.toUpperCase(), url, undefined, options);
  for (const method of ["post", "put", "patch"]) http[method] = (url, data, options) => request(method.toUpperCase(), url, data, options);
  return http;
}

export const promises = {
  resolve: value => Promise.resolve(value),
  reject: error => Promise.reject(error),
  all: values => Promise.all(values),
  defer() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  },
};
