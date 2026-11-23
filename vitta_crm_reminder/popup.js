chrome.storage.local.get(["vittaReminderGroups", "vittaReminderSampleKeys"]).then(data => {
  const groups = Object.values(data.vittaReminderGroups || {});
  const total = groups.reduce((sum, group) => sum + (group.tasks?.length || 0), 0);
  document.getElementById("status").textContent = total
    ? `Monitorando ${total} tarefa(s) em ${groups.length} horário(s).`
    : "Aguardando dados do Nave CRM…";

  // Copia apenas os NOMES dos campos (sem valores), útil para ajustar o mapeamento do card
  const btn = document.getElementById("copyKeys");
  btn.addEventListener("click", async () => {
    const keys = data.vittaReminderSampleKeys || [];
    await navigator.clipboard.writeText(keys.join("\n") || "(nenhum dado capturado ainda)");
    btn.textContent = "Copiado!";
    setTimeout(() => (btn.textContent = "Copiar nomes dos campos da API"), 1500);
  });
});

// ---------- Painel de teste ----------
const SAMPLE_TASKS = [
  { uuid: "", customer_name: "Cliente Teste Um", funnel_name: "CADÊNCIA", type_name: "TENTATIVA - 2° C", company_name: "VITTA VENDAS FRANCA", user_name: "Sergio Henrique Da Silva" },
  { uuid: "", customer_name: "Cliente Teste Dois", funnel_name: "PROSPECT (EM CONTATO)", type_name: "ENVIAR INFORMAÇÕES", company_name: "VITTA VENDAS FRANCA", user_name: "Sergio Henrique Da Silva" },
  { uuid: "", customer_name: "Cliente Teste Três", funnel_name: "PROSPECT (EM CONTATO)", type_name: "FLUXO DE CADÊNCIA", company_name: "VITTA VENDAS FRANCA", user_name: "Sergio Henrique Da Silva" }
];

function buildTestGroup(qty) {
  const now = new Date();
  const p = n => String(n).padStart(2, "0");
  return {
    key: "teste",
    date: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`,
    time: `${p(now.getHours())}:${p(now.getMinutes())}`,
    timestamp: now.getTime(),
    tasks: SAMPLE_TASKS.slice(0, qty).map(t => ({ ...t, date: now.toISOString() }))
  };
}

document.querySelectorAll(".t").forEach(btn => {
  btn.addEventListener("click", async () => {
    const msg = document.getElementById("testMsg");
    const qty = Number(document.getElementById("qty").value);
    const tabs = await chrome.tabs.query({ url: "https://crm.nave.app.br/*" });
    // Prefere a aba ativa (senão a primeira) — evita disparar em várias abas
    const tab = tabs.find(t => t.active) || tabs[0];
    if (tab?.id == null) {
      msg.textContent = "Abra o Nave CRM em uma aba para testar.";
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "SHOW_GROUP_ALERT",
        group: buildTestGroup(qty),
        stage: btn.dataset.stage
      });
      msg.textContent = "Alerta de teste enviado para a aba do CRM.";
    } catch (_) {
      msg.textContent = "Não consegui falar com a aba. Atualize a página do CRM (F5) e tente de novo.";
    }
  });
});

// ---------- Diagnóstico ----------
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function renderDiag() {
  const d = await chrome.storage.local.get(["vittaReminderActivities", "vittaReminderGroups", "vittaReminderLastCapture", "vittaReminderUrl"]);
  const alarms = (await chrome.alarms.getAll()).filter(a => a.name.startsWith("vitta-reminder:"));
  const now = Date.now();
  const groups = Object.values(d.vittaReminderGroups || {});
  const upcoming = groups.filter(g => g.timestamp + 5 * 60000 > now);
  const upcomingTasks = upcoming.reduce((s, g) => s + g.tasks.length, 0);
  const next = alarms.length ? Math.min(...alarms.map(a => a.scheduledTime)) : null;
  const last = d.vittaReminderLastCapture;
  document.getElementById("diag").textContent = [
    `Última captura: ${last ? fmtTime(last) : "nunca"}`,
    `URL da consulta salva: ${d.vittaReminderUrl ? "sim" : "não"}`,
    `Atividades guardadas: ${Object.keys(d.vittaReminderActivities || {}).length}`,
    `Tarefas pendentes futuras: ${upcomingTasks}`,
    `Alarmes agendados: ${alarms.length}${next ? ` (próximo às ${fmtTime(next)})` : ""}`
  ].join("\n");
}
renderDiag();

document.getElementById("refreshNow").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ url: "https://crm.nave.app.br/*" });
  const tab = tabs.find(t => t.active) || tabs[0];
  if (tab?.id != null) await chrome.tabs.sendMessage(tab.id, { type: "REFRESH_ACTIVITIES" }).catch(() => {});
  setTimeout(renderDiag, 1500);
});

document.getElementById("testNotif").addEventListener("click", () => {
  chrome.notifications.create("vitta:teste", {
    type: "basic",
    iconUrl: "icon128.png",
    title: "Teste de notificação",
    message: "Se você viu isto, as notificações do sistema funcionam.",
    priority: 2
  });
});
