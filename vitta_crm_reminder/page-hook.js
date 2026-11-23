(() => {
  if (window.__vittaCrmReminderHookInstalled) return;
  window.__vittaCrmReminderHookInstalled = true;

  const API_HOST = "crm-server.nave.app.br";
  const API_PATH_SUFFIX = "/api/activities";

  // Última requisição de atividades observada (url, método, headers)
  let lastRequest = null;
  // URL salva de sessões anteriores (vem do content script)
  let storedUrl = null;
  // Headers (ex.: Authorization) da requisição mais recente do CRM para a API.
  // Ficam só em memória nesta página, nunca são gravados.
  let authHeaders = {};
  let storedReplayDone = false;

  function parseUrl(rawUrl) {
    try { return new URL(rawUrl, location.href); } catch { return null; }
  }

  // Mesma validação para fetch e XHR — evita pegar URLs como /api/activities/123
  function matchActivitiesUrl(rawUrl) {
    const parsed = parseUrl(rawUrl);
    if (!parsed) return null;
    if (parsed.hostname !== API_HOST) return null;
    if (!parsed.pathname.endsWith(API_PATH_SUFFIX)) return null;
    return parsed;
  }

  function isApiHost(rawUrl) {
    return parseUrl(rawUrl)?.hostname === API_HOST;
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

  function rememberAuth(headers) {
    const h = cloneHeaders(headers);
    if (Object.keys(h).length) {
      authHeaders = h;
      maybeReplayStored();
    }
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
    const input = args[0];
    let requestUrl = "";
    try {
      requestUrl = typeof input === "string" ? input : (input && input.url) || "";
      if (isApiHost(requestUrl)) {
        const h = args[1]?.headers || (input && typeof input === "object" ? input.headers : null);
        rememberAuth(h);
      }
    } catch (_) {}

    const response = await originalFetch.apply(this, args);
    try {
      if (matchActivitiesUrl(requestUrl)) {
        const h = args[1]?.headers || (input && typeof input === "object" ? input.headers : null);
        response.clone().json().then(data => {
          saveLastRequest(requestUrl, { method: args[1]?.method || input?.method, headers: h });
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
    try {
      if (isApiHost(this.__vittaRequestUrl || "")) rememberAuth(this.__vittaHeaders);
    } catch (_) {}
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

  // Reexecuta a consulta de atividades. Usa a última observada nesta página; se ainda não
  // houve nenhuma, usa a URL salva de antes, com os headers de autenticação capturados
  // de qualquer outra chamada do CRM. Só GET/HEAD, para não alterar nada no CRM.
  async function replayLastRequest() {
    const target = lastRequest || (storedUrl ? { url: storedUrl, method: "GET", headers: authHeaders } : null);
    if (!target) return false;
    if (target.method !== "GET" && target.method !== "HEAD") return false;
    try {
      const headers = Object.keys(target.headers || {}).length ? target.headers : authHeaders;
      const res = await originalFetch(target.url, {
        method: target.method,
        headers,
        credentials: "include",
        cache: "no-store"
      });
      if (!res.ok) return false;
      const data = await res.json();
      send(target.url, data);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Busca a URL salva uma vez por página; repete quando os headers de auth forem capturados
  function maybeReplayStored() {
    if (lastRequest || !storedUrl || storedReplayDone) return;
    replayLastRequest().then(ok => { if (ok) storedReplayDone = true; });
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== "vitta-crm-reminder") return;

    if (msg.type === "REFRESH_ACTIVITIES") {
      replayLastRequest();
    } else if (msg.type === "SET_ACTIVITIES_URL" && typeof msg.url === "string" && matchActivitiesUrl(msg.url)) {
      storedUrl = msg.url;
      maybeReplayStored();
    }
  });
})();
