(() => {
  if (window.__vittaCrmReminderHookInstalled) return;
  window.__vittaCrmReminderHookInstalled = true;

  const API_HOST = "crm-server.nave.app.br";
  const API_PATH_SUFFIX = "/api/activities";

  // Última requisição bem-sucedida capturada do CRM — usada no refresh automático
  let lastRequest = null;

  // Mesma validação para fetch e XHR — evita pegar URLs como /api/activities/123
  function matchActivitiesUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl, location.href);
      if (parsed.hostname !== API_HOST) return null;
      if (!parsed.pathname.endsWith(API_PATH_SUFFIX)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  const send = (url, data) => {
    const parsed = matchActivitiesUrl(url);
    if (!parsed) return;
    if (!data || !Array.isArray(data.results)) return;
    try {
      window.postMessage({
        source: "vitta-crm-reminder",
        type: "ACTIVITIES_DATA",
        requestUrl: parsed.href,
        payload: data
      }, location.origin);
    } catch (_) {}
  };

  // Clona headers (Headers / array / objeto) para reuso
  function cloneHeaders(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) {
      const out = {};
      headers.forEach((v, k) => { out[k] = v; });
      return out;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...headers };
  }

  function saveLastRequest(url, init) {
    try {
      lastRequest = {
        url,
        method: (init?.method || "GET").toUpperCase(),
        headers: cloneHeaders(init?.headers)
      };
    } catch (_) {}
  }

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const requestUrl = typeof input === "string" ? input :
        (input && input.url) || "";
      if (matchActivitiesUrl(requestUrl)) {
        response.clone().json().then(data => {
          saveLastRequest(requestUrl, args[1] || {});
          send(requestUrl, data);
        }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__vittaRequestUrl = url;
    this.__vittaMethod = method;
    this.__vittaHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this.__vittaHeaders) this.__vittaHeaders[name] = value;
    return originalSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", function() {
      try {
        if (this.status < 200 || this.status >= 300) return;
        const url = this.__vittaRequestUrl || "";
        if (!matchActivitiesUrl(url)) return;
        const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
        saveLastRequest(url, { method: this.__vittaMethod, headers: this.__vittaHeaders });
        send(url, data);
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };

  // Reexecuta a última requisição observada (usa a mesma URL, método e headers,
  // portanto reaproveita cookies/token do usuário). Só GET/HEAD para não arriscar
  // criar/alterar nada no CRM.
  async function replayLastRequest() {
    if (!lastRequest) return;
    if (lastRequest.method !== "GET" && lastRequest.method !== "HEAD") return;
    try {
      const res = await originalFetch(lastRequest.url, {
        method: lastRequest.method,
        headers: lastRequest.headers,
        credentials: "include",
        cache: "no-store"
      });
      if (!res.ok) return;
      const data = await res.json();
      send(lastRequest.url, data);
    } catch (_) {}
  }

  // Pedido de refresh vindo do content script (disparado pelo background ou foco da aba)
  window.addEventListener("message", event => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== "vitta-crm-reminder" || msg.type !== "REFRESH_ACTIVITIES") return;
    replayLastRequest();
  });
})();