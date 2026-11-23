const PREFIX = "vitta-reminder:";
const GROUPS_KEY = "vittaReminderGroups";
const FIRED_KEY = "vittaReminderFired";
const ACT_KEY = "vittaReminderActivities";
const URL_KEY = "vittaReminderUrl";
const CAPTURE_KEY = "vittaReminderLastCapture";
const STAGE_LABEL = { before: "em 5 minutos", ontime: "agora", after: "há 5 minutos" };

// Alarme de sincronização: reexecuta a última consulta /api/activities do CRM
// de tempos em tempos. Começa com 1 min e repete a cada SYNC_INTERVAL_MIN.
const SYNC_ALARM = "vitta-reminder-sync";
const SYNC_INTERVAL_MIN = 5;

// Alarme usado pelo botão de teste do popup (alerta em janela)
const TEST_ALARM = "vitta-test-window";

// ---------- Mensagens e eventos ----------

// Fila para processar uma resposta por vez (evita corrida entre várias respostas simultâneas)
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch(() => {});
  return queue;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ACTIVITIES_DATA" && message.payload) {
    enqueue(async () => {
      const meta = { [CAPTURE_KEY]: Date.now() };
      if (message.requestUrl) meta[URL_KEY] = message.requestUrl;
      await chrome.storage.local.set(meta);
      await processActivities(message.payload);
    });
    return;
  }
  if (message?.type === "GET_ACTIVITIES_URL") {
    chrome.storage.local.get(URL_KEY).then(d => sendResponse({ url: d[URL_KEY] || null }));
    return true; // resposta assíncrona
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SYNC_ALARM) {
    requestSync().catch(() => {});
    return;
  }
  if (alarm.name === TEST_ALARM) {
    openAlertWindow("teste", "ontime", 3).catch(() => {});
    return;
  }
  if (!alarm.name.startsWith(PREFIX)) return;
  fireAlert(alarm.name).catch(() => {});
});

// Cria o alarme de sincronização de forma idempotente
chrome.alarms.get(SYNC_ALARM, alarm => {
  if (!alarm) {
    chrome.alarms.create(SYNC_ALARM, {
      periodInMinutes: SYNC_INTERVAL_MIN,
      delayInMinutes: 1
    });
  }
});

// Ao instalar/atualizar/iniciar o Chrome, recria os alarmes a partir do que está salvo
chrome.runtime.onInstalled.addListener(() => enqueue(reconcileAlarms));
chrome.runtime.onStartup.addListener(() => enqueue(reconcileAlarms));

// Pede refresh imediato ao trocar para uma aba do CRM
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => {
    if (tab.url?.startsWith("https://crm.nave.app.br/")) {
      chrome.tabs.sendMessage(tabId, { type: "REFRESH_ACTIVITIES" }).catch(() => {});
    }
  }).catch(() => {});
});

// Clicar na notificação do sistema foca/abre o CRM
chrome.notifications.onClicked.addListener(async id => {
  chrome.notifications.clear(id);
  const [tab] = await chrome.tabs.query({ url: "https://crm.nave.app.br/*" });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: "https://crm.nave.app.br/activities" });
  }
});

async function requestSync() {
  const tabs = await chrome.tabs.query({ url: "https://crm.nave.app.br/*" });
  const tab = tabs.find(t => t.active) || tabs[0];
  if (tab?.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "REFRESH_ACTIVITIES" }).catch(() => {});
}

// ---------- Utilitários ----------

function localDateParts(date) {
  const pad = n => String(n).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  };
}

// Lê um campo por caminho ("user.name"), testando vários nomes possíveis
function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (value != null && value !== "" && typeof value !== "object") return String(value);
  }
  return "";
}

const USER_FIELDS = ["user_name", "responsible_name", "assigned_name", "owner_name", "user.name", "responsible.name", "owner.name", "created_by_name"];
const COMPANY_FIELDS = ["company_name", "team_name", "unit_name", "department_name", "organization_name", "store_name", "company.name", "team.name"];

function flattenKeys(obj, prefix = "") {
  return Object.entries(obj || {}).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) && !prefix
      ? flattenKeys(v, `${k}.`)
      : [`${prefix}${k}`]
  );
}

function activityDate(value) {
  if (!value) return null;
  // A API observada retorna ISO com Z; Date converte automaticamente para o fuso local do computador.
  if (typeof value === "string" && !value.includes("T")) {
    return new Date(`${value}T10:00:00`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isFinished(activity) {
  if (activity.is_finished === true) return true;
  const status = String(activity.status || "").toLowerCase();
  return ["finished", "completed", "concluded", "concluida", "concluída", "concluído"].includes(status);
}

// ---------- Processamento ----------

async function processActivities(payload) {
  const incoming = Array.isArray(payload.results) ? payload.results : [];

  // Mescla com o que já temos (por uuid) em vez de sobrescrever
  const store = (await chrome.storage.local.get(ACT_KEY))[ACT_KEY] || {};
  for (const a of incoming) if (a?.uuid) store[a.uuid] = a;

  // Descarta atividades com mais de 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, a] of Object.entries(store)) {
    const d = activityDate(a.date);
    if (!d || d.getTime() < cutoff) delete store[id];
  }

  await chrome.storage.local.set({
    [ACT_KEY]: store,
    vittaReminderSampleKeys: incoming.length ? flattenKeys(incoming[0]) : []
  });

  await reconcileAlarms();
}

// Monta os grupos a partir das atividades salvas e sincroniza os alarmes
async function reconcileAlarms() {
  const store = (await chrome.storage.local.get(ACT_KEY))[ACT_KEY] || {};
  const groups = new Map();

  for (const activity of Object.values(store)) {
    if (isFinished(activity)) continue;

    const date = activityDate(activity.date);
    if (!date) continue;
    const parts = localDateParts(date);
    const key = `${parts.date}_${parts.time}`;
    if (!groups.has(key)) groups.set(key, { key, date: parts.date, time: parts.time, timestamp: date.getTime(), tasks: [] });
    groups.get(key).tasks.push({
      uuid: activity.uuid || "",
      customer_name: activity.customer_name || "",
      type_name: activity.type_name || "",
      funnel_name: activity.funnel_name || "",
      status: activity.status || "",
      date: typeof activity.date === "string" ? activity.date : "",
      user_name: pick(activity, USER_FIELDS),
      company_name: pick(activity, COMPANY_FIELDS)
    });
  }

  const allGroups = [...groups.values()];
  await chrome.storage.local.set({
    [GROUPS_KEY]: Object.fromEntries(allGroups.map(g => [g.key, g]))
  });

  // Limpa "já disparados" de grupos que não existem mais
  const valid = new Set(allGroups.flatMap(g => ["before", "ontime", "after"].map(s => `${g.key}:${s}`)));
  const fired = (await chrome.storage.local.get(FIRED_KEY))[FIRED_KEY] || {};
  const pruned = Object.fromEntries(Object.entries(fired).filter(([k]) => valid.has(k)));
  await chrome.storage.local.set({ [FIRED_KEY]: pruned });

  // Reconcilia alarmes: cria os que faltam, remove os que sobraram
  const now = Date.now();
  const wanted = new Map();
  for (const g of allGroups) {
    const moments = [
      ["before", g.timestamp - 5 * 60000],
      ["ontime", g.timestamp],
      ["after", g.timestamp + 5 * 60000]
    ];
    for (const [stage, when] of moments) {
      if (when > now + 1000 && !pruned[`${g.key}:${stage}`]) {
        wanted.set(`${PREFIX}${g.key}:${stage}`, when);
      }
    }
  }

  const existing = (await chrome.alarms.getAll()).filter(a => a.name.startsWith(PREFIX));
  const existingMap = new Map(existing.map(a => [a.name, a.scheduledTime]));
  for (const name of existingMap.keys()) {
    if (!wanted.has(name)) await chrome.alarms.clear(name);
  }
  for (const [name, when] of wanted) {
    if (existingMap.get(name) !== when) chrome.alarms.create(name, { when });
  }
}

// ---------- Disparo do alerta ----------

async function fireAlert(alarmName) {
  const suffix = alarmName.slice(PREFIX.length);
  const splitAt = suffix.lastIndexOf(":");
  const key = suffix.slice(0, splitAt);
  const stage = suffix.slice(splitAt + 1);
  const firedKey = `${key}:${stage}`;

  const fired = (await chrome.storage.local.get(FIRED_KEY))[FIRED_KEY] || {};
  if (fired[firedKey]) return;

  const groups = (await chrome.storage.local.get(GROUPS_KEY))[GROUPS_KEY] || {};
  const group = groups[key];
  if (!group || !group.tasks?.length) return;

  // Marca como disparado já, porque a notificação do sistema sempre é entregue
  await chrome.storage.local.set({ [FIRED_KEY]: { ...fired, [firedKey]: true } });

  // 1) Notificação do sistema (aparece mesmo com o Chrome minimizado, se o sistema permitir)
  const names = group.tasks.map(t => t.customer_name || "Cliente").slice(0, 4).join("\n");
  chrome.notifications.create(`vitta:${firedKey}`, {
    type: "basic",
    iconUrl: "icon128.png",
    title: `${group.tasks.length} tarefa(s) ${STAGE_LABEL[stage] || ""} · ${group.time}`,
    message: names,
    priority: 2
  });

  // 2) Se o CRM está visível na tela, mostra o popup dentro da página.
  //    Caso contrário (minimizado, outra aba, outro programa), abre uma janela própria.
  let shownInPage = false;
  const tabs = await chrome.tabs.query({ url: "https://crm.nave.app.br/*" });
  const tab = tabs.find(t => t.active) || tabs[0];
  if (tab?.id != null) {
    try {
      const win = await chrome.windows.get(tab.windowId);
      const visible = tab.active && win.focused && win.state !== "minimized";
      if (visible) {
        await chrome.tabs.sendMessage(tab.id, { type: "SHOW_GROUP_ALERT", group, stage });
        shownInPage = true;
      }
    } catch (_) {}
  }
  if (!shownInPage) await openAlertWindow(key, stage, group.tasks.length);
}

// Abre uma janela de popup independente (alert.html) na frente de tudo
async function openAlertWindow(key, stage, count) {
  const height = Math.min(190 + count * 170, 720);
  const url = chrome.runtime.getURL(`alert.html?key=${encodeURIComponent(key)}&stage=${encodeURIComponent(stage)}`);
  await chrome.windows.create({ url, type: "popup", width: 420, height, focused: true });
}
