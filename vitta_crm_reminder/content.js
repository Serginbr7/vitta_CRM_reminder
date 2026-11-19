(() => {
  if (window.__vittaCrmReminderContentInstalled) return;
  window.__vittaCrmReminderContentInstalled = true;

  const HOST_ID = "vitta-crm-reminder-alert";
  const AUTO_CLOSE_MS = 15000;
  const RESUME_AFTER_HOVER_MS = 5000;
  let closeTimer = null;

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== "vitta-crm-reminder" || msg.type !== "ACTIVITIES_DATA") return;
    chrome.runtime.sendMessage({ type: "ACTIVITIES_DATA", payload: msg.payload }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === "SHOW_GROUP_ALERT") showAlert(message.group, message.stage);
  });

  // Cores da borda lateral seguem o padrão dos cards do CRM
  const STAGES = {
    before: { label: "em 5 minutos", tone: "success" },
    ontime: { label: "no horário marcado", tone: "warning" },
    after:  { label: "há 5 minutos", tone: "late" }
  };

  // Ícones inline (não dependem da fonte Material Symbols carregada na página)
  const ICONS = {
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
    funnel:   '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
    event:    '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/><rect x="13" y="13" width="3.2" height="3.2" fill="currentColor" stroke="none"/>',
    company:  '<path d="M3 20V5h10v15M13 10h8v10M2 20h20M6.5 8.5h3M6.5 12h3M6.5 15.5h3M16.5 13.5h1M16.5 16.5h1"/>',
    close:    '<path d="M6 6l12 12M18 6L6 18"/>'
  };

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .panel{
      width:380px;max-width:calc(100vw - 36px);max-height:calc(100vh - 36px);overflow:auto;
      background:#f5f9fd;border:1px solid #e1e8f0;border-radius:8px;padding:12px;
      box-shadow:0 8px 32px rgba(15,35,70,.22);
      font-family:Roboto,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
      font-size:14px;line-height:1.4;color:#424242;
    }
    .head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
    .head img{width:22px;height:22px;border-radius:5px}
    .brand{flex:1;font-size:12px;font-weight:500;letter-spacing:.2px;color:#757575}
    .x{
      border:0;background:transparent;color:#424242;width:28px;height:28px;border-radius:50%;
      cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0
    }
    .x:hover{background:rgba(0,0,0,.07)}
    .summary{margin:0 2px 10px}
    .summary h2{margin:0;font-size:18px;font-weight:500;color:#212121}
    .summary p{margin:2px 0 0;font-size:13px;color:#757575}
    .list{display:flex;flex-direction:column;gap:10px}
    .card{
      background:#fff;border-radius:4px;border-left:4px solid var(--accent);
      padding:12px 14px 10px 12px;
      box-shadow:0 1px 5px rgba(0,0,0,.14),0 2px 2px rgba(0,0,0,.08),0 3px 1px -2px rgba(0,0,0,.08);
    }
    .card--success{--accent:#81c784;--avatar:#43a047;--avatar-fg:#fff}
    .card--warning{--accent:#ffd54f;--avatar:#fbc02d;--avatar-fg:#3e2f00}
    .card--late{--accent:#e57373;--avatar:#e53935;--avatar-fg:#fff;background:linear-gradient(90deg,#fff 35%,#fdeaea 100%)}
    .title{
      display:block;margin:0 0 8px;font-size:16px;font-weight:400;color:#1d1d1d;
      text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis
    }
    a.title:hover{text-decoration:underline}
    .rows{display:flex;flex-direction:column;gap:4px}
    .row{display:flex;align-items:center;min-width:0}
    .row svg{flex:none;width:18px;height:18px;margin-right:6px;color:#616161;
      fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
    .row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .user{display:flex;align-items:center;margin-top:10px;min-width:0}
    .avatar{
      flex:none;width:24px;height:24px;border-radius:50%;background:var(--avatar);color:var(--avatar-fg);
      font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-right:6px
    }
    .user span{font-size:14px;font-weight:500;color:#616161;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .foot{margin:10px 2px 0;font-size:11px;color:#9e9e9e}
  `;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICONS[name]; // string estática, sem dados do CRM
    return svg;
  }

  function row(iconName, text) {
    if (!text) return null;
    const r = el("div", "row");
    r.append(icon(iconName), el("span", null, text));
    return r;
  }

  function formatDateTime(task, group) {
    const raw = task.date;
    const d = raw && String(raw).includes("T") ? new Date(raw) : new Date(group.timestamp);
    if (Number.isNaN(d.getTime())) return `${group.date.split("-").reverse().join("/")} às ${group.time}`;
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} às ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function activityUrl(uuid, date) {
    const back = encodeURIComponent(encodeURIComponent(`/activities?date=${date}`));
    return `/activities/${encodeURIComponent(uuid)}/edit?overlay=true&backgroundOverlay=${back}`;
  }

  function buildCard(task, group, tone) {
    const card = el("article", `card card--${tone}`);

    const title = el(task.uuid ? "a" : "div", "title", task.customer_name || "Cliente não identificado");
    if (task.uuid) title.href = activityUrl(task.uuid, group.date);
    title.title = title.textContent;

    const rows = el("div", "rows");
    [
      row("calendar", formatDateTime(task, group)),
      row("funnel", task.funnel_name),
      row("event", task.type_name),
      row("company", task.company_name)
    ].filter(Boolean).forEach(r => rows.append(r));

    card.append(title, rows);

    if (task.user_name) {
      const user = el("div", "user");
      user.append(el("div", "avatar", task.user_name.trim().charAt(0).toUpperCase()), el("span", null, task.user_name));
      card.append(user);
    }
    return card;
  }

  function startCloseTimer(host, ms) {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => host.remove(), ms);
  }

  function showAlert(group, stage) {
    document.getElementById(HOST_ID)?.remove();
    const info = STAGES[stage] || STAGES.ontime;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;top:18px;right:18px;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;

    const panel = el("section", "panel");
    // Acessibilidade: anuncia o alerta para leitores de tela
    panel.setAttribute("role", "alert");
    panel.setAttribute("aria-live", "assertive");

    const head = el("div", "head");
    const logo = document.createElement("img");
    logo.src = chrome.runtime.getURL("icon48.png");
    logo.alt = "";
    const close = el("button", "x");
    close.type = "button";
    close.setAttribute("aria-label", "Fechar notificação");
    const closeSvg = icon("close");
    closeSvg.style.cssText = "width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round";
    close.append(closeSvg);
    head.append(logo, el("div", "brand", "Vitta CRM Reminder"), close);

    const count = group.tasks.length;
    const summary = el("div", "summary");
    summary.append(
      el("h2", null, count === 1 ? "Você tem 1 tarefa" : `Você tem ${count} tarefas`),
      el("p", null, `${info.label} · ${group.time}`)
    );

    const list = el("div", "list");
    group.tasks.forEach(task => list.append(buildCard(task, group, info.tone)));

    const foot = el("div", "foot", "Esta notificação fecha em 15 segundos. Fechar não conclui as tarefas.");

    panel.append(head, summary, list, foot);
    shadow.append(style, panel);
    document.documentElement.append(host);

    // Fecha por X ou Escape, e limpa os listeners junto
    const ac = new AbortController();
    const dismiss = () => {
      window.clearTimeout(closeTimer);
      host.remove();
      ac.abort();
    };
    close.addEventListener("click", dismiss);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") dismiss();
    }, { signal: ac.signal });

    startCloseTimer(host, AUTO_CLOSE_MS);
    panel.addEventListener("mouseenter", () => window.clearTimeout(closeTimer));
    panel.addEventListener("mouseleave", () => startCloseTimer(host, RESUME_AFTER_HOVER_MS));
  }
})();