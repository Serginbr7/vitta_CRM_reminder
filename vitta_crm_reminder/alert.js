// Janela de alerta independente do navegador: aparece mesmo com o Chrome minimizado
// ou com outra aba/programa em primeiro plano.
const AUTO_CLOSE_MS = 15000;
const RESUME_AFTER_HOVER_MS = 5000;
const CRM_ORIGIN = "https://crm.nave.app.br";

const STAGES = {
  before: { label: "em 5 minutos", tone: "success" },
  ontime: { label: "no horário marcado", tone: "warning" },
  after:  { label: "há 5 minutos", tone: "late" }
};

const ICONS = {
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  funnel:   '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  event:    '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/><rect x="13" y="13" width="3.2" height="3.2" fill="currentColor" stroke="none"/>',
  company:  '<path d="M3 20V5h10v15M13 10h8v10M2 20h20M6.5 8.5h3M6.5 12h3M6.5 15.5h3M16.5 13.5h1M16.5 16.5h1"/>',
  close:    '<path d="M6 6l12 12M18 6L6 18"/>'
};

let closeTimer = null;

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
  return `${CRM_ORIGIN}/activities/${encodeURIComponent(uuid)}/edit?overlay=true&backgroundOverlay=${back}`;
}

// Abre a tarefa numa aba do CRM e traz o navegador para frente
async function openTask(url) {
  const [tab] = await chrome.tabs.query({ url: `${CRM_ORIGIN}/*` });
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true, state: "normal" }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

function buildCard(task, group, tone) {
  const card = el("article", `card card--${tone}`);

  const title = el(task.uuid ? "a" : "div", "title", task.customer_name || "Cliente não identificado");
  if (task.uuid) {
    title.addEventListener("click", () => openTask(activityUrl(task.uuid, group.date)));
  }
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

function startCloseTimer(ms) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => window.close(), ms);
}

async function loadGroup(key) {
  if (key === "teste") {
    return (await chrome.storage.local.get("vittaReminderTestGroup")).vittaReminderTestGroup;
  }
  const groups = (await chrome.storage.local.get("vittaReminderGroups")).vittaReminderGroups || {};
  return groups[key];
}

async function main() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key") || "";
  const stage = params.get("stage") || "ontime";
  const info = STAGES[stage] || STAGES.ontime;
  const panel = document.getElementById("panel");

  const group = await loadGroup(key);
  if (!group || !group.tasks?.length) {
    panel.append(el("div", "summary", "Nenhuma tarefa encontrada para este horário."));
    startCloseTimer(5000);
    return;
  }

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

  const foot = el("div", "foot", "Esta janela fecha em 15 segundos. Fechar não conclui as tarefas.");
  panel.append(head, summary, list, foot);

  document.title = `${count} tarefa(s) · ${group.time}`;

  close.addEventListener("click", () => window.close());
  document.addEventListener("keydown", e => { if (e.key === "Escape") window.close(); });

  startCloseTimer(AUTO_CLOSE_MS);
  panel.addEventListener("mouseenter", () => clearTimeout(closeTimer));
  panel.addEventListener("mouseleave", () => startCloseTimer(RESUME_AFTER_HOVER_MS));
}

main();