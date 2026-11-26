// InfraMGNT Frontend Controller (Hosts, Backup Jobs, Maintenance Routines, WebSocket Terminal & History)

let hostsState = [];
let consoleLogs = [];
let wsConnection = null;
let wsReconnectTimer = null;
let currentUser = null;

// Intercept 401 responses globally and redirect to /login
const _origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401 && !String(args[0]).includes("/api/auth/login")) {
    window.location.href = "/login";
  }
  return res;
};

document.addEventListener("DOMContentLoaded", async () => {
  const authed = await loadCurrentUser();
  if (!authed) return;
  connectWebSocket();
  await refreshAllData();
  updateBackupPreview();
});

async function loadCurrentUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      currentUser = await res.json();
      const navUser = document.getElementById("nav-username");
      if (navUser) navUser.textContent = currentUser.username;
      return true;
    }
    window.location.href = "/login";
    return false;
  } catch (err) {
    console.error("Erro ao verificar sessão:", err);
    return false;
  }
}

async function logoutUser() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
}

function openSecurityModal() {
  document.getElementById("security-modal").classList.remove("hidden");
  loadSecurityUsers();
}

function closeSecurityModal() {
  document.getElementById("security-modal").classList.add("hidden");
}

async function loadSecurityUsers() {
  try {
    const res = await fetch("/api/auth/users");
    if (!res.ok) return;
    const users = await res.json();
    const tbody = document.getElementById("security-users-tbody");
    tbody.innerHTML = users
      .map(
        (u) => `
      <tr>
        <td class="py-2 px-3 font-mono-code font-semibold text-white">${escapeHtml(u.username)}</td>
        <td class="py-2 px-3 text-slate-300">${escapeHtml(u.full_name)}</td>
        <td class="py-2 px-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
            u.role === "admin"
              ? "bg-orange-500/15 text-orange-300 border border-orange-500/30"
              : "bg-sky-500/15 text-sky-300 border border-sky-500/30"
          }">${escapeHtml(u.role)}</span>
        </td>
        <td class="py-2 px-3 text-slate-400">${formatIsoDate(u.last_login_at)}</td>
        <td class="py-2 px-3 text-right">
          ${
            currentUser && currentUser.id !== u.id
              ? `<button onclick="deleteUserAccount(${u.id})" class="px-2 py-0.5 rounded bg-rose-950 hover:bg-rose-800 text-rose-300 text-[11px] transition">Remover</button>`
              : `<span class="text-[11px] text-slate-500">Sessão atual</span>`
          }
        </td>
      </tr>`
      )
      .join("");
  } catch (err) {
    console.error("Erro ao listar usuários:", err);
  }
}

async function submitChangePassword(event) {
  event.preventDefault();
  const current_password = document.getElementById("sec-curr-pass").value;
  const new_password = document.getElementById("sec-new-pass").value;

  const res = await fetch("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_password, new_password }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.detail || "Falha ao alterar senha.");
    return;
  }
  document.getElementById("sec-curr-pass").value = "";
  document.getElementById("sec-new-pass").value = "";
  appendLocalConsoleLine("Senha de acesso atualizada com sucesso!", "success");
  alert("Senha alterada com sucesso!");
}

async function submitNewUser(event) {
  event.preventDefault();
  const payload = {
    username: document.getElementById("sec-new-username").value.trim(),
    full_name: document.getElementById("sec-new-fullname").value.trim(),
    password: document.getElementById("sec-new-userpass").value,
    role: document.getElementById("sec-new-role").value,
  };
  const res = await fetch("/api/auth/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.detail || "Erro ao criar operador.");
    return;
  }
  document.getElementById("sec-new-username").value = "";
  document.getElementById("sec-new-fullname").value = "";
  document.getElementById("sec-new-userpass").value = "";
  await loadSecurityUsers();
}

async function deleteUserAccount(userId) {
  if (!confirm("Remover o acesso deste usuário ao InfraMGNT?")) return;
  const res = await fetch(`/api/auth/users/${userId}`, { method: "DELETE" });
  if (res.ok) {
    await loadSecurityUsers();
  } else {
    const data = await res.json();
    alert(data.detail || "Não foi possível excluir.");
  }
}

async function refreshAllData() {
  await Promise.all([loadStats(), loadHosts(), loadExecutions()]);
}

// ---------------------------------------------------------------------------
// 1. Dashboard KPIs & Hosts Management
// ---------------------------------------------------------------------------

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();

    document.getElementById("stat-hosts").textContent = `${data.online_hosts} / ${data.total_hosts}`;
    document.getElementById("stat-hosts-sub").textContent =
      data.online_hosts === data.total_hosts && data.total_hosts > 0
        ? "Todos os servidores operacionais"
        : `${data.online_hosts} servidor(es) online`;

    document.getElementById("stat-execs").textContent = data.total_executions;
    const runningEl = document.getElementById("stat-running");
    if (data.running_executions > 0) {
      runningEl.textContent = `${data.running_executions} job(s) rodando agora...`;
      runningEl.className = "text-xs text-amber-400 mt-1 animate-pulse font-medium";
    } else {
      runningEl.textContent = "Nenhum job pendente na fila";
      runningEl.className = "text-xs text-sky-400 mt-1";
    }

    document.getElementById("stat-rate").textContent = `${data.success_rate}%`;

    if (data.last_validation) {
      document.getElementById("stat-last-val").textContent =
        data.last_validation.summary || data.last_validation.job_title;
      document.getElementById("stat-last-time").textContent = formatIsoDate(
        data.last_validation.finished_at
      );
    }
  } catch (err) {
    console.error("Erro ao carregar estatísticas:", err);
  }
}

async function loadHosts() {
  try {
    const res = await fetch("/api/hosts");
    hostsState = await res.json();
    renderHostsGrid();
    populateHostDropdowns();
  } catch (err) {
    console.error("Erro ao carregar servidores:", err);
  }
}

function renderHostsGrid() {
  const container = document.getElementById("hosts-grid");
  if (!hostsState.length) {
    container.innerHTML = `
      <div class="col-span-2 p-6 text-center rounded-xl border border-dashed border-slate-800 text-slate-400 text-xs">
        Nenhum servidor cadastrado. Clique em "Adicionar Servidor" para começar.
      </div>`;
    return;
  }

  container.innerHTML = hostsState
    .map((h) => {
      const isOnline = h.last_status === "online";
      const fbActive = h.firebird_service_status === "active";
      const roleBadge =
        h.role === "production"
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-500/15 text-rose-400 border border-rose-500/30">Produção</span>`
          : `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-sky-500/15 text-sky-400 border border-sky-500/30">Teste / Validação</span>`;

      const modeBadge = h.is_simulated
        ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono-code bg-amber-500/15 text-amber-300 border border-amber-500/30" title="Simula comandos gbak/gfix localmente">SIMULAÇÃO</span>`
        : `<span class="px-2 py-0.5 rounded text-[10px] font-mono-code bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" title="Executa comandos reais via SSH">SSH REAL</span>`;

      const statusBadge = isOnline
        ? `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
             <span class="w-2 h-2 rounded-full bg-emerald-400 pulse-green"></span>
             Online ${h.last_latency_ms ? `(${h.last_latency_ms} ms)` : ""}
           </span>`
        : `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-400">
             <span class="w-2 h-2 rounded-full bg-rose-500"></span>
             Offline / Sem resposta
           </span>`;

      const fbBadge = fbActive
        ? `<span class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 font-mono-code text-[11px]">firebird: active</span>`
        : `<span class="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 font-mono-code text-[11px]">firebird: ${h.firebird_service_status}</span>`;

      return `
      <div class="rounded-xl bg-slate-950/80 border border-slate-800/90 hover:border-slate-700 p-4 flex flex-col justify-between gap-3 transition">
        <div>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              ${roleBadge}
              ${modeBadge}
            </div>
            ${statusBadge}
          </div>

          <div class="mt-2.5 flex items-baseline justify-between">
            <h3 class="text-sm font-bold text-white">${escapeHtml(h.name)}</h3>
            <span class="text-xs font-mono-code text-slate-400">${escapeHtml(h.username)}@${escapeHtml(h.hostname)}:${h.port}</span>
          </div>

          <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] bg-slate-900/70 p-2.5 rounded-lg border border-slate-800/70 font-mono-code">
            <div class="truncate" title="${escapeHtml(h.default_db_path)}">
              <span class="text-slate-500">Base:</span> <span class="text-slate-200">${escapeHtml(h.default_db_path)}</span>
            </div>
            <div class="truncate" title="${escapeHtml(h.default_backup_dir)}">
              <span class="text-slate-500">Dir. Bkp:</span> <span class="text-slate-200">${escapeHtml(h.default_backup_dir)}</span>
            </div>
          </div>
        </div>

        <div class="pt-2 border-t border-slate-900 flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            ${fbBadge}
            <span class="text-[11px] text-slate-500">${escapeHtml(h.firebird_version || "Firebird")}</span>
          </div>

          <div class="flex items-center gap-1.5">
            <button onclick="openInspectModal(${h.id})" class="px-2.5 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 text-[11px] font-medium transition">
              Inspecionar (gstat -h)
            </button>
            <button onclick="checkSingleHost(${h.id})" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium transition">
              Testar SSH
            </button>
            <button onclick="openHostModal(${h.id})" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium transition">
              Editar
            </button>
            <button onclick="deleteHost(${h.id})" class="px-2 py-1 rounded bg-slate-900 hover:bg-rose-950 text-slate-400 hover:text-rose-300 text-[11px] transition" title="Remover servidor">
              Excluir
            </button>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

function populateHostDropdowns() {
  if (!hostsState.length) return;
  const prodHosts = hostsState.filter((h) => h.role === "production");
  const testHosts = hostsState.filter((h) => h.role !== "production");

  const defaultProdId = prodHosts.length ? prodHosts[0].id : hostsState[0].id;
  const defaultTestId = testHosts.length
    ? testHosts[0].id
    : hostsState[hostsState.length - 1].id;

  const buildOpts = (selectedId) =>
    hostsState
      .map(
        (h) =>
          `<option value="${h.id}" ${h.id === selectedId ? "selected" : ""}>${escapeHtml(
            h.name
          )} (${escapeHtml(h.hostname)})</option>`
      )
      .join("");

  const prevMaintId = Number(document.getElementById("maint-host")?.value) || defaultProdId;

  document.getElementById("pipe-prod-host").innerHTML = buildOpts(defaultProdId);
  document.getElementById("pipe-test-host").innerHTML = buildOpts(defaultTestId);
  document.getElementById("bkp-host").innerHTML = buildOpts(defaultProdId);
  document.getElementById("xfer-src-host").innerHTML = buildOpts(defaultProdId);
  document.getElementById("xfer-dst-host").innerHTML = buildOpts(defaultTestId);
  document.getElementById("rest-host").innerHTML = buildOpts(defaultTestId);
  document.getElementById("maint-host").innerHTML = buildOpts(prevMaintId);

  const offlineHostEl = document.getElementById("offline-host-select");
  if (offlineHostEl) {
    const nonProdOpts = hostsState
      .filter((h) => h.role !== "production")
      .map((h) => `<option value="${h.id}">${escapeHtml(h.name)} (${escapeHtml(h.hostname)})</option>`)
      .join("");
    offlineHostEl.innerHTML = `<option value="">Container Local (Sandbox)</option>${nonProdOpts}`;
  }

  syncPipelineDefaults();
  syncMaintDefaults();
  updateBackupPreview();
}

function syncPipelineDefaults() {
  const prodId = Number(document.getElementById("pipe-prod-host").value);
  const testId = Number(document.getElementById("pipe-test-host").value);
  const prod = hostsState.find((h) => h.id === prodId);
  const test = hostsState.find((h) => h.id === testId);

  if (prod) {
    document.getElementById("pipe-prod-db").value = prod.default_db_path;
    document.getElementById("pipe-prod-bkp-dir").value = prod.default_backup_dir;
  }
  if (test) {
    document.getElementById("pipe-test-bkp-dir").value = test.default_backup_dir;
    document.getElementById("pipe-test-db").value = test.default_db_path;
  }
}

function syncMaintDefaults() {
  const hostId = Number(document.getElementById("maint-host")?.value);
  const host = hostsState.find((h) => h.id === hostId);
  if (host) {
    document.getElementById("maint-db-path").value = host.default_db_path;
  }
}

async function checkSingleHost(hostId) {
  appendLocalConsoleLine(`Testando conectividade SSH e serviço Firebird no Host #${hostId}...`, "info");
  try {
    const res = await fetch(`/api/hosts/${hostId}/check`, { method: "POST" });
    const data = await res.json();
    appendLocalConsoleLine(
      `[${data.name}] Status: ${data.last_status.toUpperCase()} | Firebird: ${data.firebird_service_status} | ${data.check_details || ""}`,
      data.last_status === "online" ? "success" : "error"
    );
    await refreshAllData();
  } catch (err) {
    appendLocalConsoleLine(`Falha ao verificar Host #${hostId}: ${err}`, "error");
  }
}

async function checkAllHosts() {
  const btn = document.getElementById("btn-check-all");
  btn.disabled = true;
  appendLocalConsoleLine("Verificando conectividade SSH e daemon Firebird em todos os servidores...", "info");
  try {
    const res = await fetch("/api/hosts/check-all", { method: "POST" });
    const list = await res.json();
    list.forEach((h) => {
      appendLocalConsoleLine(
        `[${h.name}] ${h.hostname}:${h.port} -> ${h.last_status.toUpperCase()} (${h.last_latency_ms || "--"} ms) | firebird: ${h.firebird_service_status}`,
        h.last_status === "online" ? "success" : "warn"
      );
    });
    await refreshAllData();
  } finally {
    btn.disabled = false;
  }
}

// Inspect Host Modal (gstat -h, Disk & Backups)
async function openInspectModal(hostId) {
  const modal = document.getElementById("inspect-modal");
  const title = document.getElementById("inspect-modal-title");
  const sub = document.getElementById("inspect-modal-sub");
  const body = document.getElementById("inspect-modal-body");

  title.textContent = "Inspecionando Header Page (gstat -h) & Storage...";
  sub.textContent = "";
  body.innerHTML = `<div class="py-8 text-center text-slate-400">Coletando informações via SSH...</div>`;
  modal.classList.remove("hidden");

  try {
    const res = await fetch(`/api/hosts/${hostId}/inspect`);
    const info = await res.json();

    title.textContent = `Inspeção — ${info.host_name}`;
    sub.textContent = `Base: ${info.db_path} (${info.db_size}) | ODS: ${info.ods_version} | Page Size: ${info.page_size}`;

    const backupRows = (info.backup_files || [])
      .map(
        (f) => `
        <tr class="border-b border-slate-800/70">
          <td class="py-2 px-3 font-mono-code text-sky-300">${escapeHtml(f.path)}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${escapeHtml(f.size)}</td>
          <td class="py-2 px-3 text-slate-400">${escapeHtml(f.modified)}</td>
          <td class="py-2 px-3 text-right">
            <button onclick="useBackupFile('${escapeHtml(f.path)}')" class="px-2 py-0.5 rounded bg-orange-500/20 hover:bg-orange-500 text-orange-300 hover:text-white text-[11px] font-medium transition">
              Usar nos Jobs
            </button>
          </td>
        </tr>`
      )
      .join("");

    body.innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Oldest Transaction (OIT)</span>
          <p class="text-base font-bold font-mono-code text-white mt-0.5">${info.oldest_transaction}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Oldest Active (OAT)</span>
          <p class="text-base font-bold font-mono-code text-emerald-400 mt-0.5">${info.oldest_active}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Next Transaction</span>
          <p class="text-base font-bold font-mono-code text-sky-400 mt-0.5">${info.next_transaction}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Gap (Next - OAT)</span>
          <p class="text-base font-bold font-mono-code ${info.transaction_gap > 20000 ? "text-amber-400" : "text-emerald-400"} mt-0.5">${info.transaction_gap}</p>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Disco Total</span>
          <p class="text-sm font-semibold text-white mt-0.5">${escapeHtml(info.disk_total)}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Disco em Uso</span>
          <p class="text-sm font-semibold text-amber-300 mt-0.5">${escapeHtml(info.disk_used)}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Espaço Livre</span>
          <p class="text-sm font-semibold text-emerald-400 mt-0.5">${escapeHtml(info.disk_free)}</p>
        </div>
      </div>

      <div>
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Saída Bruta do Header Page (gstat -h)</h4>
        <pre class="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono-code text-[11px] text-slate-300 overflow-x-auto">${escapeHtml(info.gstat_raw)}</pre>
      </div>

      <div>
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Arquivos de Backup Disponíveis em ${escapeHtml(info.backup_dir)}</h4>
        <div class="rounded-xl border border-slate-800 overflow-hidden bg-slate-950">
          <table class="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr class="bg-slate-900 text-slate-400 border-b border-slate-800">
                <th class="py-2 px-3">Arquivo</th>
                <th class="py-2 px-3">Tamanho</th>
                <th class="py-2 px-3">Data</th>
                <th class="py-2 px-3 text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${backupRows || `<tr><td colspan="4" class="py-4 text-center text-slate-500">Nenhum backup encontrado no diretório.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="p-4 text-rose-400">Erro ao inspecionar servidor: ${err}</div>`;
  }
}

function closeInspectModal() {
  document.getElementById("inspect-modal").classList.add("hidden");
}

function useBackupFile(path) {
  document.getElementById("xfer-file").value = path;
  document.getElementById("rest-bkp-file").value = path;
  closeInspectModal();
  appendLocalConsoleLine(`Arquivo selecionado para Jobs 2 e 3: ${path}`, "info");
}

// Host Modal CRUD
function openHostModal(hostId = null) {
  const modal = document.getElementById("host-modal");
  const title = document.getElementById("host-modal-title");
  document.getElementById("host-form").reset();

  if (hostId) {
    const h = hostsState.find((x) => x.id === hostId);
    if (!h) return;
    title.textContent = `Editar Servidor: ${h.name}`;
    document.getElementById("host-id").value = h.id;
    document.getElementById("host-name").value = h.name;
    document.getElementById("host-role").value = h.role;
    document.getElementById("host-hostname").value = h.hostname;
    document.getElementById("host-port").value = h.port;
    document.getElementById("host-username").value = h.username;
    document.getElementById("host-auth-type").value = h.auth_type;
    document.getElementById("host-secret").value = h.secret || "";
    document.getElementById("host-fb-user").value = h.fb_user;
    document.getElementById("host-fb-password").value = "********";
    document.getElementById("host-db-path").value = h.default_db_path;
    document.getElementById("host-backup-dir").value = h.default_backup_dir;
    document.getElementById("host-simulated").checked = Boolean(h.is_simulated);
  } else {
    title.textContent = "Cadastrar Novo Servidor Firebird";
    document.getElementById("host-id").value = "";
    document.getElementById("host-simulated").checked = true;
  }

  modal.classList.remove("hidden");
}

function closeHostModal() {
  document.getElementById("host-modal").classList.add("hidden");
}

async function saveHost(event) {
  event.preventDefault();
  const id = document.getElementById("host-id").value;
  const payload = {
    name: document.getElementById("host-name").value.trim(),
    role: document.getElementById("host-role").value,
    hostname: document.getElementById("host-hostname").value.trim(),
    port: Number(document.getElementById("host-port").value),
    username: document.getElementById("host-username").value.trim(),
    auth_type: document.getElementById("host-auth-type").value,
    secret: document.getElementById("host-secret").value.trim(),
    fb_user: document.getElementById("host-fb-user").value.trim(),
    fb_password: document.getElementById("host-fb-password").value,
    default_db_path: document.getElementById("host-db-path").value.trim(),
    default_backup_dir: document.getElementById("host-backup-dir").value.trim(),
    is_simulated: document.getElementById("host-simulated").checked,
  };

  const url = id ? `/api/hosts/${id}` : "/api/hosts";
  const method = id ? "PUT" : "POST";

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    closeHostModal();
    await refreshAllData();
  } else {
    const err = await res.json();
    alert(`Erro ao salvar servidor: ${err.detail || "Verifique os dados"}`);
  }
}

async function deleteHost(hostId) {
  const h = hostsState.find((x) => x.id === hostId);
  if (!confirm(`Tem certeza que deseja remover o servidor "${h ? h.name : hostId}"?`)) return;
  await fetch(`/api/hosts/${hostId}`, { method: "DELETE" });
  await refreshAllData();
}

// ---------------------------------------------------------------------------
// 2. Backup, Transfer, Restore & Maintenance Jobs
// ---------------------------------------------------------------------------

function selectJobTab(tab) {
  const tabs = ["pipeline", "backup", "transfer", "restore"];
  tabs.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const form = document.getElementById(`form-job-${t}`);
    if (t === tab) {
      btn.classList.add("job-tab-active");
      form.classList.remove("hidden");
    } else {
      btn.classList.remove("job-tab-active");
      form.classList.add("hidden");
    }
  });
}

function updateBackupPreview() {
  const dbPath = document.getElementById("bkp-db-path")?.value || "/dados/producao.fdb";
  const bkpDir = (document.getElementById("bkp-dir")?.value || "/backups").replace(/\/$/, "");
  const comp = document.getElementById("bkp-comp")?.value || "zstd";
  const noGc = document.getElementById("bkp-nogc")?.checked;
  const verbose = document.getElementById("bkp-verbose")?.checked;

  const flags = ["-b"];
  if (noGc) flags.push("-g");
  if (verbose) flags.push("-v");

  const ext = comp === "zstd" ? ".fbk.zst" : comp === "gzip" ? ".fbk.gz" : ".fbk";
  const pipe =
    comp === "zstd"
      ? `stdout | zstd -1 -T0 > ${bkpDir}/base_$(date +%Y%m%d_%H%M)${ext}`
      : comp === "gzip"
      ? `stdout | gzip -1 > ${bkpDir}/base_$(date +%Y%m%d_%H%M)${ext}`
      : `${bkpDir}/base_$(date +%Y%m%d_%H%M)${ext}`;

  const previewEl = document.getElementById("bkp-cmd-preview");
  if (previewEl) {
    previewEl.textContent = `gbak ${flags.join(" ")} -user SYSDBA -password "********" ${dbPath} ${pipe}`;
  }
}

async function submitBackupJob(event) {
  event.preventDefault();
  const payload = {
    host_id: Number(document.getElementById("bkp-host").value),
    db_path: document.getElementById("bkp-db-path").value.trim(),
    backup_dir: document.getElementById("bkp-dir").value.trim(),
    compression: document.getElementById("bkp-comp").value,
    no_gc: document.getElementById("bkp-nogc").checked,
    verbose: document.getElementById("bkp-verbose").checked,
  };
  await triggerJobEndpoint("/api/jobs/backup", payload);
}

async function submitTransferJob(event) {
  event.preventDefault();
  const payload = {
    source_host_id: Number(document.getElementById("xfer-src-host").value),
    target_host_id: Number(document.getElementById("xfer-dst-host").value),
    source_file: document.getElementById("xfer-file").value.trim(),
    target_dir: document.getElementById("xfer-target-dir").value.trim(),
    method: document.getElementById("xfer-method").value,
  };
  await triggerJobEndpoint("/api/jobs/transfer", payload);
}

async function submitRestoreJob(event) {
  event.preventDefault();
  const payload = {
    host_id: Number(document.getElementById("rest-host").value),
    backup_file: document.getElementById("rest-bkp-file").value.trim(),
    restore_db_path: document.getElementById("rest-db-path").value.trim(),
    compression: "auto",
    replace_existing: true,
    run_gfix: document.getElementById("rest-gfix").checked,
    simulate_corruption: document.getElementById("rest-sim-corrupt").checked,
  };
  await triggerJobEndpoint("/api/jobs/restore-validate", payload);
}

async function submitFullPipeline(event) {
  if (event) event.preventDefault();
  const payload = {
    prod_host_id: Number(document.getElementById("pipe-prod-host").value),
    test_host_id: Number(document.getElementById("pipe-test-host").value),
    prod_db_path: document.getElementById("pipe-prod-db").value.trim(),
    prod_backup_dir: document.getElementById("pipe-prod-bkp-dir").value.trim(),
    test_backup_dir: document.getElementById("pipe-test-bkp-dir").value.trim(),
    test_restore_db_path: document.getElementById("pipe-test-db").value.trim(),
    compression: document.getElementById("pipe-compression").value,
    no_gc: document.getElementById("pipe-nogc").checked,
    transfer_method: document.getElementById("pipe-transfer").value,
    run_gfix: document.getElementById("pipe-gfix").checked,
  };
  await triggerJobEndpoint("/api/jobs/full-pipeline", payload);
}

async function quickTriggerFullPipeline() {
  selectJobTab("pipeline");
  await submitFullPipeline(null);
}

// ---------------------------------------------------------------------------
// Offline Database Analyzer & Optimizer Lab
// ---------------------------------------------------------------------------

function uploadOfflineFile() {
  const fileInput = document.getElementById("offline-file-input");
  if (!fileInput.files || !fileInput.files.length) {
    alert("Selecione um arquivo .fdb ou .fbk no seu computador primeiro.");
    return;
  }

  const file = fileInput.files[0];
  const wrap = document.getElementById("offline-upload-progress-wrap");
  const bar = document.getElementById("offline-upload-bar");
  const pctEl = document.getElementById("offline-upload-pct");
  const statusEl = document.getElementById("offline-upload-status");
  const btn = document.getElementById("btn-offline-upload");

  wrap.classList.remove("hidden");
  btn.disabled = true;
  bar.style.width = "0%";
  pctEl.textContent = "0%";
  statusEl.textContent = `Enviando ${file.name}...`;

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/offline/upload?filename=${encodeURIComponent(file.name)}`, true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = `${pct}%`;
      pctEl.textContent = `${pct}%`;
    }
  };

  xhr.onload = async () => {
    btn.disabled = false;
    if (xhr.status >= 200 && xhr.status < 300) {
      const data = JSON.parse(xhr.responseText);
      statusEl.textContent = `Upload concluído (${data.size_formatted})!`;
      bar.style.width = "100%";
      pctEl.textContent = "100%";
      document.getElementById("offline-db-path").value = data.path;
      document.getElementById("offline-host-select").value = "";
      appendLocalConsoleLine(
        `[Laboratório Offline] Arquivo '${data.filename}' (${data.size_formatted}) recebido em ${data.path}. Iniciando Raio-X...`,
        "success"
      );
      await runOfflineXRay();
    } else {
      statusEl.textContent = "Erro no upload.";
      appendLocalConsoleLine(`Falha no upload do arquivo offline: HTTP ${xhr.status}`, "error");
    }
  };

  xhr.onerror = () => {
    btn.disabled = false;
    statusEl.textContent = "Falha de rede durante upload.";
  };

  xhr.send(file);
}

async function runOfflineXRay() {
  const dbPath = document.getElementById("offline-db-path").value.trim();
  const hostVal = document.getElementById("offline-host-select").value;
  const simProfile = document.getElementById("offline-sim-profile").value;
  const btn = document.getElementById("btn-run-xray");

  if (!dbPath) {
    alert("Informe o caminho do arquivo .fdb para analisar.");
    return;
  }

  btn.disabled = true;
  const origHtml = btn.innerHTML;
  btn.innerHTML = `<span>Analisando Páginas & Índices...</span>`;

  try {
    const res = await fetch("/api/offline/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        db_path: dbPath,
        host_id: hostVal ? Number(hostVal) : null,
        simulate_profile: simProfile,
      }),
    });
    const report = await res.json();
    if (!res.ok) {
      appendLocalConsoleLine(`Erro no Raio-X Offline: ${report.detail || "Falha"}`, "error");
      return;
    }
    renderOfflineReport(report);
    await refreshAllData();
  } catch (err) {
    appendLocalConsoleLine(`Erro ao executar Raio-X Offline: ${err}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

async function runOfflineOptimizationAction(action) {
  const dbPath = document.getElementById("offline-db-path").value.trim();
  const hostVal = document.getElementById("offline-host-select").value;

  appendLocalConsoleLine(
    `[Laboratório Offline] Aplicando otimização '${action.toUpperCase()}' no arquivo ${dbPath}...`,
    "info"
  );

  try {
    const res = await fetch("/api/offline/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        db_path: dbPath,
        host_id: hostVal ? Number(hostVal) : null,
        action,
      }),
    });
    const updatedReport = await res.json();
    if (!res.ok) {
      appendLocalConsoleLine(`Erro na otimização offline: ${updatedReport.detail || "Falha"}`, "error");
      return;
    }
    document.getElementById("offline-sim-profile").value = "healthy";
    renderOfflineReport(updatedReport);
    await refreshAllData();
  } catch (err) {
    appendLocalConsoleLine(`Falha na requisição de otimização offline: ${err}`, "error");
  }
}

function renderOfflineReport(rep) {
  const container = document.getElementById("offline-report-container");
  container.classList.remove("hidden");

  const scoreColor =
    rep.health_score >= 85
      ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
      : rep.health_score >= 55
      ? "text-amber-300 border-amber-500/40 bg-amber-500/10"
      : "text-rose-400 border-rose-500/40 bg-rose-500/10";

  const recCards = (rep.recommendations || [])
    .map((r) => {
      const badge =
        r.severity === "critical"
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30">Crítico • Ação Necessária</span>`
          : r.severity === "warning"
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">Recomendado</span>`
          : `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">OK • Saudável</span>`;

      const actionBtn = r.action_id
        ? `<button onclick="runOfflineOptimizationAction('${r.action_id}')" class="mt-3 w-full py-2 px-3 rounded-lg bg-cyan-600/25 hover:bg-cyan-600 text-cyan-200 hover:text-white border border-cyan-500/40 text-xs font-semibold transition">
             ⚡ ${escapeHtml(r.action_label)}
           </button>`
        : "";

      return `
        <div class="rounded-xl bg-slate-950/90 border border-slate-800 p-4 flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between gap-2 mb-2">
              <span class="text-[11px] font-semibold text-slate-400 uppercase">${escapeHtml(r.category)}</span>
              ${badge}
            </div>
            <h4 class="text-sm font-bold text-white">${escapeHtml(r.title)}</h4>
            <p class="text-xs text-slate-400 mt-1.5 leading-relaxed">${escapeHtml(r.detail)}</p>
          </div>
          ${actionBtn}
        </div>`;
    })
    .join("");

  const tableRows = (rep.tables || [])
    .map((t) => {
      const stBadge =
        t.status === "critical"
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300">Precisa Sweep</span>`
          : t.status === "warning"
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300">Lixo Moderado</span>`
          : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">Limpa</span>`;
      return `
        <tr class="border-b border-slate-800/70">
          <td class="py-2 px-3 font-mono-code font-semibold text-white">${escapeHtml(t.table_name)}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${Number(t.total_records).toLocaleString("pt-BR")}</td>
          <td class="py-2 px-3 font-mono-code font-bold ${t.backversions > 10000 ? "text-amber-300" : "text-emerald-400"}">${Number(t.backversions).toLocaleString("pt-BR")}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${t.max_versions}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${t.avg_fill_pct}%</td>
          <td class="py-2 px-3 text-right">${stBadge}</td>
        </tr>`;
    })
    .join("");

  const indexRows = (rep.indices || [])
    .map((i) => {
      const stBadge =
        i.depth >= 4
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300">Depth ${i.depth} (Rebuild 16K)</span>`
          : i.depth === 3
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300">Depth 3 (Recalcular)</span>`
          : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">Depth ${i.depth} (Ótimo)</span>`;
      return `
        <tr class="border-b border-slate-800/70">
          <td class="py-2 px-3 font-mono-code font-semibold text-white">${escapeHtml(i.index_name)}</td>
          <td class="py-2 px-3 font-mono-code font-bold ${i.depth >= 3 ? "text-amber-300" : "text-emerald-400"}">${i.depth}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${Number(i.nodes).toLocaleString("pt-BR")}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${i.dup_ratio_pct}%</td>
          <td class="py-2 px-3 text-right">${stBadge}</td>
        </tr>`;
    })
    .join("");

  container.innerHTML = `
    <!-- Top Summary Banner -->
    <div class="rounded-2xl bg-slate-950 border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-4">
        <div class="px-4 py-3 rounded-xl border ${scoreColor} text-center">
          <span class="text-[10px] font-mono-code uppercase block">Health Score</span>
          <span class="text-2xl font-extrabold font-mono-code">${rep.health_score}/100</span>
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h3 class="text-base font-bold text-white">${escapeHtml(rep.overall_status)}</h3>
            <span class="text-xs font-mono-code text-slate-400">(${escapeHtml(rep.file_size)})</span>
          </div>
          <p class="text-xs font-mono-code text-slate-400 mt-0.5">
            Arquivo: <span class="text-cyan-300">${escapeHtml(rep.db_path)}</span> | Page Size: <span class="text-white">${rep.page_size}</span> | ODS: <span class="text-white">${escapeHtml(rep.ods_version)}</span> | Gap OAT-OIT: <span class="text-white">${Number(rep.gap_oat_oit).toLocaleString("pt-BR")}</span>
          </p>
        </div>
      </div>

      <button
        onclick="runOfflineOptimizationAction('all')"
        class="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/20 flex items-center gap-2 transition"
      >
        <span>⚡ Aplicar Todas as Correções Offline (1-Clique)</span>
      </button>
    </div>

    <!-- 4 Diagnostic Cards ("O que o banco precisa?") -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      ${recCards}
    </div>

    <!-- Detailed Tables: Garbage by Table & Index Depth -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden">
        <div class="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <span class="text-xs font-bold text-white">Raio-X de Tabelas & Lixo Acumulado (gstat -r)</span>
          <span class="text-[11px] font-mono-code text-slate-400">Total Lixo: ${Number(rep.total_backversions).toLocaleString("pt-BR")}</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="text-[11px] text-slate-400 border-b border-slate-800 bg-slate-950">
                <th class="py-2 px-3">Tabela</th>
                <th class="py-2 px-3">Registros</th>
                <th class="py-2 px-3">Backversions (Lixo)</th>
                <th class="py-2 px-3">Max Ver.</th>
                <th class="py-2 px-3">Ocupação</th>
                <th class="py-2 px-3 text-right">Diagnóstico</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>

      <div class="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden">
        <div class="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <span class="text-xs font-bold text-white">Raio-X de Índices B-Tree (gstat -i)</span>
          <span class="text-[11px] font-mono-code text-slate-400">Ideal: Depth &le; 2</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="text-[11px] text-slate-400 border-b border-slate-800 bg-slate-950">
                <th class="py-2 px-3">Índice</th>
                <th class="py-2 px-3">Depth</th>
                <th class="py-2 px-3">Nós (Chaves)</th>
                <th class="py-2 px-3">% Duplicatas</th>
                <th class="py-2 px-3 text-right">Diagnóstico</th>
              </tr>
            </thead>
            <tbody>${indexRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// Maintenance Routines from ROTINAS_MANUTENCAO.md
async function runMaintenanceJob(jobId) {
  const hostId = Number(document.getElementById("maint-host").value);
  const dbPath = document.getElementById("maint-db-path").value.trim();
  const host = hostsState.find((h) => h.id === hostId);
  const confirmDowntime = document.getElementById("maint-confirm-downtime")?.checked || false;
  const linuxMode = document.getElementById("maint-linux-mode")?.value || "audit_only";

  if (jobId === "job_full_rebuild" && !confirmDowntime) {
    appendLocalConsoleLine(
      "ATENÇÃO: O job_full_rebuild exige parada da base (gfix -shut). Marque a caixa 'Confirmar parada (Janela)' no card antes de disparar.",
      "warn"
    );
    return;
  }

  const payload = {
    job_id: jobId,
    host_id: hostId,
    db_path: dbPath,
    backup_dir: host ? host.default_backup_dir : "/backups",
    warn_gap_threshold: 20000,
    force_shutdown_timeout: 30,
    confirm_downtime: confirmDowntime,
    linux_action_mode: linuxMode,
  };

  await triggerJobEndpoint("/api/jobs/maintenance", payload);
}

async function triggerJobEndpoint(url, payload) {
  try {
    document.getElementById("terminal-status-text").textContent = "Executando Job remoto via SSH...";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLocalConsoleLine(`Erro ao iniciar Job: ${data.detail || "Falha"}`, "error");
      return;
    }
    if (data.output_file) {
      document.getElementById("xfer-file").value = data.output_file;
    }
    await refreshAllData();
  } catch (err) {
    appendLocalConsoleLine(`Falha de comunicação com a API: ${err}`, "error");
  }
}

// ---------------------------------------------------------------------------
// 3. Real-Time WebSocket Terminal Console
// ---------------------------------------------------------------------------

function connectWebSocket() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}/ws/logs`;
  wsConnection = new WebSocket(wsUrl);

  wsConnection.onopen = () => {
    const dot = document.getElementById("ws-dot");
    const txt = document.getElementById("ws-text");
    dot.className = "w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-green";
    txt.textContent = "Stream Ativo (WebSocket)";
  };

  wsConnection.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "clear") {
      consoleLogs = [];
      renderConsoleLines();
      return;
    }
    if (msg.type === "log") {
      consoleLogs.push(msg);
      renderConsoleLines();
    } else if (msg.type === "status") {
      const statusLabel =
        msg.status === "success"
          ? "CONCLUÍDO COM SUCESSO"
          : msg.status === "warning"
          ? "FINALIZADO COM ALERTA"
          : "FALHA NA EXECUÇÃO";
      document.getElementById("terminal-status-text").textContent =
        `Job #${msg.execution_id} (${msg.job_title}): ${statusLabel} em ${msg.duration_seconds?.toFixed(2) || 0}s`;
      await refreshAllData();
    }
  };

  wsConnection.onclose = () => {
    const dot = document.getElementById("ws-dot");
    const txt = document.getElementById("ws-text");
    dot.className = "w-2.5 h-2.5 rounded-full bg-rose-500";
    txt.textContent = "Reconectando Stream...";
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, 2500);
  };
}

function appendLocalConsoleLine(text, level = "info") {
  const now = new Date().toTimeString().slice(0, 8);
  consoleLogs.push({
    type: "log",
    timestamp: now,
    host: "InfraMGNT",
    step: "SYS",
    level,
    line: text,
  });
  renderConsoleLines();
}

function renderConsoleLines() {
  const container = document.getElementById("terminal-output");
  const filter = document.getElementById("console-filter").value;

  const filtered = consoleLogs.filter((item) => {
    if (filter === "cmd") return item.level === "cmd";
    if (filter === "warn_err") return item.level === "warn" || item.level === "error";
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div class="text-slate-500 italic py-6 text-center">
        Console pronto. Dispare um Job de Backup/Restore ao lado ou uma Rotina de Manutenção abaixo para acompanhar a saída em tempo real.
      </div>`;
    document.getElementById("terminal-line-count").textContent = "0 linhas";
    return;
  }

  container.innerHTML = filtered
    .map((item) => {
      let colorClass = "text-slate-300";
      let badgeClass = "bg-slate-800 text-slate-300";

      if (item.level === "cmd") {
        colorClass = "text-sky-300 font-semibold";
        badgeClass = "bg-sky-500/20 text-sky-300 border border-sky-500/30";
      } else if (item.level === "success") {
        colorClass = "text-emerald-400 font-medium";
        badgeClass = "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
      } else if (item.level === "warn") {
        colorClass = "text-amber-300 font-medium";
        badgeClass = "bg-amber-500/20 text-amber-300 border border-amber-500/30";
      } else if (item.level === "error") {
        colorClass = "text-rose-400 font-semibold";
        badgeClass = "bg-rose-500/20 text-rose-300 border border-rose-500/30";
      }

      const stepTag = item.step
        ? `<span class="px-1.5 py-0.2 rounded text-[10px] ${badgeClass}">${escapeHtml(item.step)}</span>`
        : "";

      return `
        <div class="log-line flex items-start gap-2 py-0.5 px-1.5 rounded">
          <span class="text-slate-500 shrink-0 select-none">[${escapeHtml(item.timestamp || "")}]</span>
          <span class="text-orange-400/90 shrink-0 font-medium">[${escapeHtml(item.host || "Host")}]</span>
          ${stepTag}
          <span class="${colorClass}">${escapeHtml(item.line)}</span>
        </div>`;
    })
    .join("");

  document.getElementById("terminal-line-count").textContent = `${filtered.length} linhas`;

  if (document.getElementById("console-autoscroll").checked) {
    container.scrollTop = container.scrollHeight;
  }
}

async function clearConsole() {
  await fetch("/api/console/clear", { method: "POST" });
  consoleLogs = [];
  renderConsoleLines();
}

function copyConsoleLogs() {
  const text = consoleLogs
    .map((l) => `[${l.timestamp}] [${l.host}] ${l.step ? `[${l.step}] ` : ""}${l.line}`)
    .join("\n");
  navigator.clipboard.writeText(text);
  appendLocalConsoleLine("Logs copiados para a área de transferência.", "success");
}

// ---------------------------------------------------------------------------
// 4. Execution History & Log Viewer Modal
// ---------------------------------------------------------------------------

async function loadExecutions() {
  try {
    const res = await fetch("/api/executions?limit=30");
    const list = await res.json();
    const tbody = document.getElementById("executions-tbody");

    if (!list.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="py-8 text-center text-slate-500">
            Nenhuma rotina executada ainda. Use o Catálogo de Jobs acima para iniciar.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = list
      .map((ex) => {
        let statusBadge = "";
        if (ex.status === "success") {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">Sucesso</span>`;
        } else if (ex.status === "warning") {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">Alerta</span>`;
        } else if (ex.status === "error") {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30">Erro</span>`;
        } else {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/30 animate-pulse">Executando...</span>`;
        }

        const hostsLabel =
          ex.source_host_name && ex.target_host_name
            ? `${escapeHtml(ex.source_host_name)} &rarr; ${escapeHtml(ex.target_host_name)}`
            : escapeHtml(ex.source_host_name || ex.target_host_name || "-");

        const duration = ex.duration_seconds != null ? `${ex.duration_seconds}s` : "...";

        return `
          <tr class="hover:bg-slate-800/40 transition">
            <td class="py-3 px-4 font-mono-code font-semibold text-orange-400">#${ex.id}</td>
            <td class="py-3 px-4 text-slate-300 whitespace-nowrap">${formatIsoDate(ex.started_at)}</td>
            <td class="py-3 px-4 font-semibold text-white">${escapeHtml(ex.job_title)}</td>
            <td class="py-3 px-4 text-slate-300">${hostsLabel}</td>
            <td class="py-3 px-4 text-slate-300 max-w-md truncate" title="${escapeHtml(ex.summary || "")}">
              ${escapeHtml(ex.summary || ex.command_preview || "")}
            </td>
            <td class="py-3 px-4 font-mono-code text-slate-300">${duration}</td>
            <td class="py-3 px-4">${statusBadge}</td>
            <td class="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
              <button onclick="openLogModal(${ex.id})" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium transition">
                Ver Log
              </button>
              <a href="/api/executions/${ex.id}/download" download class="inline-block px-2.5 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 text-[11px] font-medium transition">
                .log
              </a>
            </td>
          </tr>`;
      })
      .join("");
  } catch (err) {
    console.error("Erro ao carregar histórico:", err);
  }
}

async function openLogModal(execId) {
  const modal = document.getElementById("log-modal");
  const title = document.getElementById("log-modal-title");
  const sub = document.getElementById("log-modal-sub");
  const content = document.getElementById("log-modal-content");
  const dl = document.getElementById("log-modal-download");

  title.textContent = `Carregando Log da Execução #${execId}...`;
  content.textContent = "Carregando...";
  dl.href = `/api/executions/${execId}/download`;
  modal.classList.remove("hidden");

  try {
    const res = await fetch(`/api/executions/${execId}/log`);
    const data = await res.json();
    title.textContent = `Execução #${execId} — ${data.execution.job_title}`;
    sub.textContent = `Comando: ${data.execution.command_preview || ""}`;
    content.textContent = data.log_content || "Sem conteúdo de log.";
  } catch (err) {
    content.textContent = `Erro ao carregar log: ${err}`;
  }
}

function closeLogModal() {
  document.getElementById("log-modal").classList.add("hidden");
}

// Helpers
function formatIsoDate(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
