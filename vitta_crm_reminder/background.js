const PREFIX = "vitta-reminder:";
const GROUPS_KEY = "vittaReminderGroups";
const FIRED_KEY = "vittaReminderFired";
const SIG_KEY = "vittaReminderSig";

// Alarme de sincronização: reexecuta a última consulta /api/activities do CRM
// de tempos em tempos. Começa com 1 min e repete a cada SYNC_INTERVAL_MIN.
const SYNC_ALARM = "vitta-reminder-sync";
const SYNC_INTERVAL_MIN = 5;

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "ACTIVITIES_DATA" && message.payload) {
    processActivities(message.payload).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SYNC_ALARM) {
    requestSync().catch(() => {});
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

// Pede refresh imediato ao trocar para uma aba do CRM
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => {
    if (tab.url?.startsWith("https://crm.nave.app.br/")) {
      chrome.tabs.sendMessage(tabId, { type: "REFRESH_ACTIVITIES" }).catch(() => {});
    }
  }).catch(() => {});
});

async function requestSync() {
  const tabs = await chrome.tabs.query({ url: "https://crm.nave.app.br/*" });
  const tab = tabs.find(t => t.active) || tabs[0];
  if (tab?.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "REFRESH_ACTIVITIES" }).catch(() => {});
}

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

async function processActivities(payload) {
  const activities = Array.isArray(payload.results) ? payload.results : [];
  const groups = new Map();

  for (const activity of activities) {
    if (activity.is_finished === true) continue;
    const status = String(activity.status || "").toLowerCase();
    if (["finished", "completed", "concluded", "concluida", "concluído"].includes(status)) continue;

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
    [GROUPS_KEY]: Object.fromEntries(allGroups.map(g => [g.key, g])),
    vittaReminderSampleKeys: activities.length ? flattenKeys(activities[0]) : []
  });

  // Remove da lista de "já disparados" tudo que não corresponde a um grupo atual.
  const validFiredKeys = new Set();
  for (const g of allGroups) {
    validFiredKeys.add(`${g.key}:before`);
    validFiredKeys.add(`${g.key}:ontime`);
    validFiredKeys.add(`${g.key}:after`);
  }
  const fired = (await chrome.storage.local.get(FIRED_KEY))[FIRED_KEY] || {};
  const pruned = Object.fromEntries(Object.entries(fired).filter(([k]) => validFiredKeys.has(k)));
  if (Object.keys(pruned).length !== Object.keys(fired).length) {
    await chrome.storage.local.set({ [FIRED_KEY]: pruned });
  }

  // Só recria alarms se o conjunto de grupos agendados mudou.
  const sig = allGroups.map(g => `${g.key}@${g.timestamp}`).sort().join("|");
  const lastSig = (await chrome.storage.local.get(SIG_KEY))[SIG_KEY];
  if (sig === lastSig) return;

  const existing = await chrome.alarms.getAll();
  await Promise.all(existing.filter(a => a.name.startsWith(PREFIX)).map(a => chrome.alarms.clear(a.name)));

  const now = Date.now();
  for (const group of allGroups) {
    const moments = [
      ["before", group.timestamp - 5 * 60 * 1000],
      ["ontime", group.timestamp],
      ["after", group.timestamp + 5 * 60 * 1000]
    ];
    for (const [stage, when] of moments) {
      if (when > now + 1000) {
        chrome.alarms.create(`${PREFIX}${group.key}:${stage}`, { when });
      }
    }
  }

  await chrome.storage.local.set({ [SIG_KEY]: sig });
}

async function fireAlert(alarmName) {
  const suffix = alarmName.slice(PREFIX.length);
  const splitAt = suffix.lastIndexOf(":");
  const key = suffix.slice(0, splitAt);
  const stage = suffix.slice(splitAt + 1);
  const fired = (await chrome.storage.local.get(FIRED_KEY))[FIRED_KEY] || {};
  const firedKey = `${key}:${stage}`;
  if (fired[firedKey]) return;

  const groups = (await chrome.storage.local.get(GROUPS_KEY))[GROUPS_KEY] || {};
  const group = groups[key];
  if (!group || !group.tasks?.length) return;

  const tabs = await chrome.tabs.query({ url: "https://crm.nave.app.br/*" });
  if (!tabs.length) return;
  const tab = tabs.find(t => t.active) || tabs[0];
  if (tab?.id == null) return;

  await chrome.storage.local.set({ [FIRED_KEY]: { ...fired, [firedKey]: true } });
  chrome.tabs.sendMessage(tab.id, { type: "SHOW_GROUP_ALERT", group, stage }).catch(() => {});
}