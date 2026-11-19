(() => {
  if (window.__vittaCrmReminderHookInstalled) return;
  window.__vittaCrmReminderHookInstalled = true;

  const API_HOST = "crm-server.nave.app.br";
  const API_PATH_SUFFIX = "/api/activities";

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

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const requestUrl = typeof args[0] === "string" ? args[0] :
        (args[0] && args[0].url) || "";
      if (matchActivitiesUrl(requestUrl)) {
        response.clone().json().then(data => send(requestUrl, data)).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__vittaRequestUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", function() {
      try {
        if (this.status < 200 || this.status >= 300) return;
        const url = this.__vittaRequestUrl || "";
        if (!matchActivitiesUrl(url)) return;
        const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
        send(url, data);
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();