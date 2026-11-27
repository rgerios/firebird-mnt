// Firebird Command Center — Venosan Brasil (Temporal Telemetry, TV NOC Mode, Offline Lab & Backup Orchestrator)

let hostsState = [];
let consoleLogs = [];
let wsConnection = null;
let wsReconnectTimer = null;
let currentUser = null;
let isTvNocMode = false;
let telemetryTimer = null;

// Chart.js instances (3 Temporal Line Charts + 3 Structural Charts)
let timeRamCpuChart = null;
let timeConnsIoChart = null;
let timeTxGapChart = null;
let memoryChartInstance = null;
let tablesChartInstance = null;
let serverHealthChartInstance = null;
let currentTelemetryHostId = null;
let currentTelemetryRangeKey = "1h";
let isTemporalFullWidthCols = false;

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
  startWallboardClock();
  const authed = await loadCurrentUser();
  if (!authed) return;
  connectWebSocket();
  await refreshAllData();
  await loadHostTelemetry();
  updateBackupPreview();

  // Auto-refresh temporal telemetry every 10 seconds for TV NOC Wallboard
  telemetryTimer = setInterval(() => {
    loadHostTelemetry();
    if (isTvNocMode) {
      loadStats();
      loadExecutions();
    }
  }, 10000);
});

function startWallboardClock() {
  const updateClock = () => {
    const el = document.getElementById("tv-clock");
    if (el) {
      el.textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });
    }
  };
  updateClock();
  setInterval(updateClock, 1000);
}

async function loadCurrentUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      currentUser = await res.json();
      const navUser = document.getElementById("nav-username");
      if (navUser) navUser.textContent = currentUser.username;

      // If logged in as read-only user (`firebird-ro`), automatically activate TV NOC Wallboard Mode
      if (currentUser.role === "readonly") {
        activateReadOnlyTvMode();
      }
      return true;
    }
    window.location.href = "/login";
    return false;
  } catch (err) {
    console.error("Erro ao verificar sessão:", err);
    return false;
  }
}

function activateReadOnlyTvMode() {
  isTvNocMode = true;
  document.body.classList.add("tv-noc-mode");
  document.getElementById("tv-mode-banner")?.classList.remove("hidden");
  document.getElementById("tv-mode-banner")?.classList.add("inline-flex");
  document.getElementById("ro-user-pill")?.classList.remove("hidden");
  const roleBadge = document.getElementById("role-badge-header");
  if (roleBadge) {
    roleBadge.textContent = "SOMENTE LEITURA • TV NOC";
    roleBadge.className = "text-[10px] font-mono-code uppercase px-2.5 py-0.5 rounded-full bg-sky-400/20 text-sky-200 border border-sky-400/40 font-bold";
  }
  const tvBtn = document.getElementById("btn-tv-mode");
  if (tvBtn && currentUser?.role === "readonly") {
    tvBtn.classList.add("hidden");
  }
}

function toggleTvNocMode() {
  if (currentUser?.role === "readonly") return; // locked in TV mode for firebird-ro
  isTvNocMode = !isTvNocMode;
  const banner = document.getElementById("tv-mode-banner");
  const btn = document.getElementById("btn-tv-mode");
  if (isTvNocMode) {
    document.body.classList.add("tv-noc-mode");
    banner?.classList.remove("hidden");
    banner?.classList.add("inline-flex");
    if (btn) btn.innerHTML = `<span>🛠️ Voltar ao Modo Admin</span>`;
  } else {
    document.body.classList.remove("tv-noc-mode");
    banner?.classList.add("hidden");
    banner?.classList.remove("inline-flex");
    if (btn) btn.innerHTML = `<span>📺 Modo TV NOC</span>`;
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
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${u.role === "admin"
            ? "bg-teal-300/15 text-teal-200 border border-teal-300/30"
            : u.role === "readonly"
              ? "bg-violet-300/15 text-violet-200 border border-violet-300/30"
              : "bg-sky-300/15 text-sky-200 border border-sky-300/30"
          }">${escapeHtml(u.role === "readonly" ? "TV / Somente Leitura" : u.role)}</span>
        </td>
        <td class="py-2 px-3 text-slate-400">${formatIsoDate(u.last_login_at)}</td>
        <td class="py-2 px-3 text-right">
          ${currentUser && currentUser.id !== u.id
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
    alert(data.detail || "Erro ao criar usuário.");
    return;
  }
  document.getElementById("sec-new-username").value = "";
  document.getElementById("sec-new-fullname").value = "";
  document.getElementById("sec-new-userpass").value = "";
  await loadSecurityUsers();
}

async function deleteUserAccount(userId) {
  if (!confirm("Remover o acesso deste usuário ao Firebird Command Center?")) return;
  const res = await fetch(`/api/auth/users/${userId}`, { method: "DELETE" });
  if (res.ok) {
    await loadSecurityUsers();
  } else {
    const data = await res.json();
    alert(data.detail || "Não foi possível excluir.");
  }
}

function selectMainTab(tab) {
  const dashBlocks = document.querySelectorAll(".main-dashboard-block");
  const repPanel = document.getElementById("tab-panel-reports");
  const sqlPanel = document.getElementById("tab-panel-sqlutils");
  const btnDash = document.getElementById("main-tab-btn-dashboard");
  const btnRep = document.getElementById("main-tab-btn-reports");
  const btnSql = document.getElementById("main-tab-btn-sqlutils");

  const inactiveCls = "px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700 font-semibold text-xs transition flex items-center gap-1.5";
  const activeCls = "px-4 py-2 rounded-xl bg-[#00a896] text-slate-950 font-bold text-xs shadow-lg shadow-teal-500/20 transition flex items-center gap-1.5";

  if (btnDash) btnDash.className = tab === "dashboard" ? activeCls : inactiveCls;
  if (btnRep) btnRep.className = tab === "reports" ? activeCls : inactiveCls;
  if (btnSql) btnSql.className = tab === "sqlutils" ? activeCls : inactiveCls;

  if (tab === "reports") {
    dashBlocks.forEach((el) => el.classList.add("hidden"));
    if (repPanel) repPanel.classList.remove("hidden");
    if (sqlPanel) sqlPanel.classList.add("hidden");
    loadDailyReports();
  } else if (tab === "sqlutils") {
    dashBlocks.forEach((el) => el.classList.add("hidden"));
    if (repPanel) repPanel.classList.add("hidden");
    if (sqlPanel) sqlPanel.classList.remove("hidden");
    const qEl = document.getElementById("sqlu-query");
    if (qEl && !qEl.value.trim()) applySqlUtilsPreset();
  } else {
    dashBlocks.forEach((el) => el.classList.remove("hidden"));
    if (repPanel) repPanel.classList.add("hidden");
    if (sqlPanel) sqlPanel.classList.add("hidden");
    updateEmptyTelemetryState();
  }
}

function updateEmptyTelemetryState() {
  const hasHosts = hostsState.length > 0;
  const isDemo = hostsState.some((h) => h.is_simulated);
  const onDashboard = document.getElementById("tab-panel-reports")?.classList.contains("hidden");

  const telSec = document.getElementById("telemetry-section");
  const telEmpty = document.getElementById("telemetry-empty-state");
  if (onDashboard) {
    if (telSec) telSec.classList.toggle("hidden", !hasHosts);
    if (telEmpty) telEmpty.classList.toggle("hidden", hasHosts);
  }

  const demoBtn = document.getElementById("btn-demo-mode");
  const demoPill = document.getElementById("demo-active-pill");
  if (demoBtn) {
    demoBtn.innerHTML = isDemo ? `<span>🎭 Sair da Demonstração</span>` : `<span>🎭 Demonstração</span>`;
    demoBtn.className = isDemo
      ? "ro-hide-btn px-3 py-2 rounded-xl bg-violet-500 text-white border border-violet-300 text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-violet-500/25 transition"
      : "ro-hide-btn px-3 py-2 rounded-xl bg-violet-500/15 hover:bg-violet-500/30 text-violet-200 border border-violet-400/35 text-xs font-semibold flex items-center gap-1.5 transition";
  }
  if (demoPill) demoPill.classList.toggle("hidden", !isDemo);

  if (!hasHosts) {
    const ramEl = document.getElementById("stat-fb-ram");
    const connEl = document.getElementById("stat-fb-conns");
    if (ramEl) ramEl.textContent = "--";
    if (connEl) connEl.textContent = "Aguardando servidor real";
    currentTelemetryHostId = null;
  }
}

async function toggleDemoMode() {
  const isDemo = hostsState.some((h) => h.is_simulated);
  const endpoint = isDemo ? "/api/demo/disable" : "/api/demo/enable";
  const res = await fetch(endpoint, { method: "POST" });
  if (res.ok) {
    currentTelemetryHostId = null;
    await refreshAllData();
    await loadHostTelemetry();
  } else {
    alert("Não foi possível alternar o Modo Demonstração.");
  }
}

async function refreshAllData() {
  await Promise.all([loadStats(), loadHosts(), loadExecutions(), loadDailyReports(), loadSchedules()]);
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
      runningEl.textContent = `${data.running_executions} job(s) em execução...`;
      runningEl.className = "text-xs text-amber-300 font-semibold animate-pulse";
    } else {
      runningEl.textContent = "Fila livre • Monitorando";
      runningEl.className = "text-xs text-teal-200";
    }

    document.getElementById("stat-rate").textContent = `${data.success_rate}%`;

    if (data.last_validation) {
      document.getElementById("stat-last-val").textContent =
        data.last_validation.summary || data.last_validation.job_title;
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
    updateEmptyTelemetryState();
    container.innerHTML = `
      <div class="col-span-2 p-8 text-center rounded-xl border border-dashed border-slate-700 bg-slate-950/60 space-y-3">
        <p class="text-sm font-bold text-white">Nenhum servidor cadastrado</p>
        <p class="text-xs text-slate-400 max-w-md mx-auto">
          Cadastre um servidor Firebird real para iniciar a telemetria e os backups, ou ative o Modo Demonstração com dados fictícios.
        </p>
        <div class="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <button onclick="openHostModal()" class="px-4 py-2 rounded-xl bg-[#00a896] hover:bg-teal-500 text-slate-950 font-bold text-xs transition">
            + Cadastrar Servidor Real
          </button>
          <button onclick="toggleDemoMode()" class="px-4 py-2 rounded-xl bg-violet-500/20 hover:bg-violet-500/35 text-violet-200 border border-violet-400/40 font-semibold text-xs transition">
            🎭 Ativar Modo Demonstração
          </button>
        </div>
      </div>`;
    return;
  }
  updateEmptyTelemetryState();

  container.innerHTML = hostsState
    .map((h) => {
      const isOnline = h.last_status === "online";
      const fbActive = h.firebird_service_status === "active";
      const isProd = h.role === "production";

      const cardStyle = isProd ? "warm-card-io" : "pastel-card-manage";
      const roleBadge = isProd
        ? `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-400/20 text-amber-200 border border-amber-400/40">Banco Produção</span>`
        : `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-sky-300/15 text-sky-200 border border-sky-300/30">Teste / Homologação</span>`;

      const modeBadge = h.is_simulated
        ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono-code bg-violet-300/15 text-violet-200 border border-violet-300/30">SIMULAÇÃO</span>`
        : `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono-code bg-teal-300/20 text-teal-200 border border-teal-300/40">SSH REAL</span>`;

      const statusBadge = isOnline
        ? `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-200">
             <span class="w-2 h-2 rounded-full bg-[#00a896] pulse-green"></span>
             Online ${h.last_latency_ms ? `(${h.last_latency_ms} ms)` : ""}
           </span>`
        : `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-300">
             <span class="w-2 h-2 rounded-full bg-rose-400"></span>
             Offline
           </span>`;

      const fbBadge = fbActive
        ? `<span class="px-2 py-0.5 rounded-lg bg-teal-300/15 text-teal-200 border border-teal-300/25 font-mono-code text-[11px]">firebird: active</span>`
        : `<span class="px-2 py-0.5 rounded-lg bg-rose-500/15 text-rose-200 border border-rose-400/30 font-mono-code text-[11px]">firebird: ${h.firebird_service_status}</span>`;

      return `
      <div class="rounded-2xl ${cardStyle} p-4 flex flex-col justify-between gap-3 transition">
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
            <span class="text-xs font-mono-code text-slate-300">${escapeHtml(h.username)}@${escapeHtml(h.hostname)}:${h.port}</span>
          </div>

          <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/80 font-mono-code">
            <div class="truncate" title="${escapeHtml(h.default_db_path)}">
              <span class="text-slate-400">Base:</span> <span class="text-teal-100">${escapeHtml(h.default_db_path)}</span>
            </div>
            <div class="truncate" title="${escapeHtml(h.default_backup_dir)}">
              <span class="text-slate-400">Backups:</span> <span class="text-sky-100">${escapeHtml(h.default_backup_dir)}</span>
            </div>
          </div>
        </div>

        <div class="pt-2.5 border-t border-slate-800/70 flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            ${fbBadge}
            <span class="text-[11px] text-slate-400">${escapeHtml(h.firebird_version || "Firebird")}</span>
          </div>

          <div class="flex items-center gap-1.5">
            <button onclick="loadHostTelemetry(${h.id})" class="px-2.5 py-1 rounded-lg bg-[#00a896]/25 hover:bg-[#00a896] text-teal-100 hover:text-white border border-teal-300/30 text-[11px] font-semibold transition">
              📊 Focar Gráficos
            </button>
            <button onclick="openInspectModal(${h.id})" class="px-2.5 py-1 rounded-lg bg-sky-300/15 hover:bg-sky-300/30 text-sky-100 border border-sky-300/30 text-[11px] font-medium transition">
              gstat -h
            </button>
            <button onclick="checkSingleHost(${h.id})" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium transition">
              Ping
            </button>
            <button onclick="openHostModal(${h.id})" class="ro-hide-btn px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium transition">
              Editar
            </button>
            <button onclick="deleteHost(${h.id})" class="ro-hide-btn px-2 py-1 rounded-lg bg-slate-900 hover:bg-rose-950 text-slate-400 hover:text-rose-200 text-[11px] transition" title="Remover servidor">
              ✕
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

  if (!currentTelemetryHostId) {
    currentTelemetryHostId = defaultProdId;
  }

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

  const setHtml = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };

  setHtml("pipe-prod-host", buildOpts(defaultProdId));
  setHtml("pipe-test-host", buildOpts(defaultTestId));
  setHtml("bkp-host", buildOpts(defaultProdId));
  setHtml("xfer-src-host", buildOpts(defaultProdId));
  setHtml("xfer-dst-host", buildOpts(defaultTestId));
  setHtml("rest-host", buildOpts(defaultTestId));
  setHtml("maint-host", buildOpts(prevMaintId));
  setHtml("telemetry-host-select", buildOpts(currentTelemetryHostId));
  setHtml("sched-prod-host", buildOpts(defaultProdId));
  setHtml("sched-test-host", buildOpts(defaultTestId));
  setHtml("sqlu-host", buildOpts(defaultProdId));

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

// ---------------------------------------------------------------------------
// 2. Real-Time Temporal & Structural Telemetry Charts (Chart.js)
// ---------------------------------------------------------------------------

async function loadHostTelemetry(hostId = null) {
  if (hostId) {
    currentTelemetryHostId = Number(hostId);
    const sel = document.getElementById("telemetry-host-select");
    if (sel) sel.value = String(currentTelemetryHostId);
  } else if (!currentTelemetryHostId && hostsState.length) {
    const prod = hostsState.find((h) => h.role === "production") || hostsState[0];
    currentTelemetryHostId = prod.id;
  }
  if (!currentTelemetryHostId) return;

  try {
    const res = await fetch(
      `/api/hosts/${currentTelemetryHostId}/timeseries?range_key=${encodeURIComponent(currentTelemetryRangeKey)}&limit=24`
    );
    if (!res.ok) return;
    const payload = await res.json();
    const info = payload.latest;
    const series = payload.series || [];

    document.getElementById("telemetry-host-badge").textContent = `${info.host_name} (${info.hostname || ""})`;
    const exactVerEl = document.getElementById("telemetry-fb-exact-version");
    if (exactVerEl && info.firebird_exact_version) {
      exactVerEl.textContent = info.firebird_exact_version;
    }

    const mem = info.memory || {
      ram_total_mb: 16384,
      firebird_rss_mb: 2048,
      firebird_pct: 12.5,
      os_cache_mb: 6144,
      other_processes_mb: 1536,
      ram_free_mb: 6656,
    };

    document.getElementById("stat-fb-ram").textContent = `${mem.firebird_rss_mb} MB (${mem.firebird_pct}%)`;
    document.getElementById("stat-fb-conns").textContent = `${info.active_connections || 0} sessões ativas na porta 3050`;

    // Temporal Header Badges
    document.getElementById("ts-ram-now").textContent = `${mem.firebird_rss_mb} MB • CPU ${info.cpu_load_pct}%`;
    document.getElementById("ts-conn-now").textContent = `${info.active_connections || 0} sessões 3050`;
    document.getElementById("ts-gap-now").textContent = `Gap Next-OAT: ${info.transaction_gap}`;

    // Check rfunc status
    const rfuncSvc = (info.services || []).find((s) => s.id === "rfunc");
    const rfuncEl = document.getElementById("stat-rfunc-status");
    if (rfuncSvc && rfuncSvc.status === "active") {
      rfuncEl.textContent = "Firebird & rfunc.so OK";
      rfuncEl.className = "text-xl font-extrabold text-teal-200 mt-1";
    } else {
      rfuncEl.textContent = "Verificar rfunc.so";
      rfuncEl.className = "text-xl font-extrabold text-amber-300 mt-1";
    }

    // Structural Chart footers
    document.getElementById("chart-ram-badge").textContent = `${(mem.ram_total_mb / 1024).toFixed(0)} GB Total`;
    document.getElementById("ram-fb-val").textContent = `${mem.firebird_rss_mb} MB`;
    document.getElementById("ram-cache-val").textContent = `${mem.os_cache_mb} MB`;
    document.getElementById("ram-free-val").textContent = `${mem.ram_free_mb} MB`;

    document.getElementById("chart-gap-badge").textContent = `Gap Next-OAT: ${info.transaction_gap}`;
    document.getElementById("tel-oit").textContent = info.oldest_transaction;
    document.getElementById("tel-oat").textContent = info.oldest_active;
    document.getElementById("tel-next").textContent = info.next_transaction;
    document.getElementById("tel-pagesize").textContent = info.page_size;

    document.getElementById("tel-db-size").textContent = info.db_size;
    document.getElementById("tel-disk-free").textContent = info.disk_free;
    document.getElementById("tel-conns").textContent = `${info.active_connections || 0} ativas`;

    renderTemporalCharts(series);
    renderTelemetryCharts(info);
    renderTelemetryServices(info.services || []);
  } catch (err) {
    console.error("Erro ao carregar telemetria temporal:", err);
  }
}

async function setTelemetryTimeRange(rangeKey) {
  currentTelemetryRangeKey = rangeKey;
  ["30m", "1h", "3h", "6h", "12h", "24h"].forEach((rk) => {
    const btn = document.getElementById(`tr-btn-${rk}`);
    if (btn) {
      if (rk === rangeKey) {
        btn.classList.add("time-range-btn-active");
      } else {
        btn.classList.remove("time-range-btn-active");
      }
    }
  });
  await loadHostTelemetry();
}

function resizeTemporalCharts(heightPx) {
  document.querySelectorAll(".TemporalChartBox").forEach((box) => {
    box.style.height = `${heightPx}px`;
  });
  [timeRamCpuChart, timeConnsIoChart, timeTxGapChart].forEach((ch) => {
    if (ch) ch.resize();
  });
}

function toggleTemporalLayoutCols() {
  isTemporalFullWidthCols = !isTemporalFullWidthCols;
  const grid = document.getElementById("temporal-charts-grid");
  const btn = document.getElementById("btn-toggle-cols");
  if (!grid) return;

  if (isTemporalFullWidthCols) {
    grid.className = "grid grid-cols-1 gap-4";
    if (btn) btn.textContent = "⊞ 3 Colunas (Lado a Lado)";
    resizeTemporalCharts(280);
  } else {
    grid.className = "grid grid-cols-1 lg:grid-cols-3 gap-4";
    ["card-ts-1", "card-ts-2", "card-ts-3"].forEach((id) => {
      document.getElementById(id)?.classList.remove("lg:col-span-3");
    });
    if (btn) btn.textContent = "⤢ Largura Total (1 Col)";
    resizeTemporalCharts(192);
  }
}

function toggleSingleChartExpand(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const box = card.querySelector(".TemporalChartBox");
  const expanded = card.classList.toggle("lg:col-span-3");
  if (box) {
    box.style.height = expanded ? "340px" : "192px";
  }
  [timeRamCpuChart, timeConnsIoChart, timeTxGapChart].forEach((ch) => {
    if (ch) ch.resize();
  });
}

// ---------------------------------------------------------------------------
// 2.5 Daily 24h Database Intelligence Reports (HTML & Table Movement)
// ---------------------------------------------------------------------------

async function loadDailyReports() {
  try {
    if (!hostsState.length) {
      document.getElementById("rep-added-24h").textContent = "--";
      document.getElementById("rep-removed-24h").textContent = "--";
      document.getElementById("rep-net-24h").textContent = "--";
      document.getElementById("rep-size-delta-24h").textContent = "Cadastre um servidor para gerar relatórios";
      document.getElementById("rep-top-table").textContent = "--";
      document.getElementById("rep-top-table-sub").textContent = "--";
      document.getElementById("rep-period-badge").textContent = "--";
      const bkpSumEl = document.getElementById("rep-backup-summary");
      const bkpCntEl = document.getElementById("rep-backup-counts");
      if (bkpSumEl) bkpSumEl.textContent = "Nenhum servidor cadastrado. Cadastre um servidor ou ative o Modo Demonstração.";
      if (bkpCntEl) bkpCntEl.innerHTML = "";
      const tbody = document.getElementById("rep-tables-tbody");
      if (tbody) tbody.innerHTML = "";
      const histEl = document.getElementById("rep-history-list");
      if (histEl) histEl.innerHTML = `<div class="p-4 text-center text-slate-500">Nenhum relatório gerado ainda.</div>`;
      return;
    }

    const hostId = currentTelemetryHostId || hostsState[0].id;
    const res = await fetch(`/api/reports?host_id=${hostId}`);
    if (!res.ok) return;
    const reports = await res.json();
    if (!reports.length) {
      const histEl = document.getElementById("rep-history-list");
      if (histEl) histEl.innerHTML = `<div class="p-4 text-center text-slate-500">Nenhum relatório gerado ainda. Clique em "Gerar Relatório Agora" ou aguarde às 00:00.</div>`;
      return;
    }

    const latest = reports[0];
    const sum = latest.summary || {};
    const bkp = sum.backup_summary_24h || {};

    const bkpSumEl = document.getElementById("rep-backup-summary");
    const bkpCntEl = document.getElementById("rep-backup-counts");
    if (bkpSumEl) {
      bkpSumEl.textContent = bkp.last_backup_summary || "Nenhuma execução de backup registrada nas últimas 24h.";
    }
    if (bkpCntEl) {
      bkpCntEl.innerHTML = `
        <span class="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-slate-200">Total: ${bkp.total_jobs || 0}</span>
        <span class="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">OK: ${bkp.success_jobs || 0}</span>
        <span class="px-2.5 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300">Falhas: ${bkp.error_jobs || 0}</span>
      `;
    }

    document.getElementById("rep-added-24h").textContent = `+${Number(latest.records_added_24h || 0).toLocaleString("pt-BR")}`;
    document.getElementById("rep-removed-24h").textContent = `-${Number(latest.records_removed_24h || 0).toLocaleString("pt-BR")}`;
    document.getElementById("rep-net-24h").textContent = `+${Number(latest.net_growth_24h || 0).toLocaleString("pt-BR")} regs`;
    document.getElementById("rep-size-delta-24h").textContent = `Expansão física: +${Number(latest.size_delta_mb_24h || 0).toFixed(1)} MB (Base: ${sum.db_size_current || "6.84 GB"})`;
    document.getElementById("rep-top-table").textContent = latest.top_growing_table || "--";
    document.getElementById("rep-top-table-sub").textContent = `+${Number(latest.top_growing_count || 0).toLocaleString("pt-BR")} novos registros (+${sum.top_growing_mb || 68.2} MB)`;
    document.getElementById("rep-period-badge").textContent = latest.period_label || latest.report_date;

    const openBtn = document.getElementById("btn-open-latest-html");
    const dlBtn = document.getElementById("btn-dl-latest-html");
    if (openBtn) openBtn.href = `/api/reports/${latest.id}/html`;
    if (dlBtn) dlBtn.href = `/api/reports/${latest.id}/download`;

    const tbls = sum.tables_breakdown || [];
    const tbody = document.getElementById("rep-tables-tbody");
    if (tbody) {
      tbody.innerHTML = tbls
        .map((t) => {
          const isTop = t.table_name === latest.top_growing_table;
          return `
            <tr class="${isTop ? "bg-amber-500/10" : "hover:bg-slate-900/60"} transition">
              <td class="py-2 px-3 font-mono-code font-bold text-white">
                ${escapeHtml(t.table_name)}
                ${isTop ? `<span class="ml-1.5 px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-amber-500/25 text-amber-200 border border-amber-400/40">🔥 TOP 24H</span>` : ""}
              </td>
              <td class="py-2 px-3 font-mono-code text-slate-300 text-right">${Number(t.total_records).toLocaleString("pt-BR")}</td>
              <td class="py-2 px-3 font-mono-code font-bold text-emerald-300 text-right">+${Number(t.added_24h).toLocaleString("pt-BR")}</td>
              <td class="py-2 px-3 font-mono-code font-semibold text-rose-300 text-right">-${Number(t.removed_24h).toLocaleString("pt-BR")}</td>
              <td class="py-2 px-3 font-mono-code font-bold text-sky-200 text-right">+${Number(t.net_delta_24h).toLocaleString("pt-BR")} (${t.growth_pct}%)</td>
              <td class="py-2 px-3 font-mono-code text-amber-200 text-right">+${Number(t.delta_mb).toFixed(1)} MB</td>
            </tr>`;
        })
        .join("");
    }

    const histEl = document.getElementById("rep-history-list");
    if (histEl) {
      histEl.innerHTML = reports
        .map(
          (r) => `
          <div class="p-3 flex items-center justify-between gap-2 hover:bg-slate-900/60 transition">
            <div>
              <p class="font-semibold text-white text-xs">Relatório #${r.id} • ${escapeHtml(r.report_date)}</p>
              <p class="text-[11px] font-mono-code text-slate-400">
                +${Number(r.records_added_24h).toLocaleString("pt-BR")} / -${Number(r.records_removed_24h).toLocaleString("pt-BR")} • Top: ${escapeHtml(r.top_growing_table)}
              </p>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <a href="/api/reports/${r.id}/html" target="_blank" class="px-2 py-1 rounded bg-sky-400/15 hover:bg-sky-400 text-sky-200 hover:text-slate-950 border border-sky-300/30 text-[11px] font-semibold transition">
                Ver HTML
              </a>
              <a href="/api/reports/${r.id}/download" download class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-mono-code transition">
                .html
              </a>
            </div>
          </div>`
        )
        .join("");
    }
  } catch (err) {
    console.error("Erro ao carregar relatórios diários:", err);
  }
}

async function generateDailyReportNow() {
  const btn = document.getElementById("btn-gen-daily-report");
  if (btn) btn.disabled = true;
  const hostId = currentTelemetryHostId || 1;
  appendLocalConsoleLine("Gerando Relatório Diário (24h) de movimentação de registros e saúde do banco em HTML...", "info");
  try {
    const res = await fetch(`/api/reports/generate?host_id=${hostId}`, { method: "POST" });
    if (res.ok) {
      const rep = await res.json();
      appendLocalConsoleLine(
        `[Relatório 24h #${rep.id}] Gerado com sucesso! +${rep.records_added_24h} adicionados, -${rep.records_removed_24h} removidos, Maior crescimento: ${rep.top_growing_table}.`,
        "success"
      );
      await loadDailyReports();
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderTemporalCharts(series) {
  if (typeof Chart === "undefined" || !series.length) return;

  const labels = series.map((p) => p.time_label);
  const rssData = series.map((p) => p.firebird_rss_mb);
  const cpuData = series.map((p) => p.cpu_load_pct);
  const connData = series.map((p) => p.active_connections);
  const ioData = series.map((p) => p.disk_io_mbps);
  const gapData = series.map((p) => p.transaction_gap);
  const latData = series.map((p) => p.latency_ms);

  const commonScaleX = {
    ticks: { color: "#94a3b8", font: { size: 9, family: "JetBrains Mono" }, maxTicksLimit: 7 },
    grid: { color: "rgba(148, 163, 184, 0.08)" },
  };

  // Temporal Chart 1: Firebird RSS (MB) & CPU (%)
  const ctx1 = document.getElementById("chartTimeRamCpu")?.getContext("2d");
  if (ctx1) {
    if (timeRamCpuChart) timeRamCpuChart.destroy();
    timeRamCpuChart = new Chart(ctx1, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Firebird RAM (MB)",
            data: rssData,
            borderColor: "#2dd4bf",
            backgroundColor: "rgba(45, 212, 191, 0.14)",
            borderWidth: 2,
            pointRadius: 1.5,
            tension: 0.35,
            fill: true,
            yAxisID: "y",
          },
          {
            label: "CPU Host (%)",
            data: cpuData,
            borderColor: "#fb923c",
            backgroundColor: "rgba(251, 146, 60, 0.08)",
            borderWidth: 2,
            pointRadius: 1.5,
            tension: 0.35,
            fill: false,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: commonScaleX,
          y: {
            position: "left",
            ticks: { color: "#5eead4", font: { size: 9 } },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
          y1: {
            position: "right",
            min: 0,
            max: 100,
            ticks: { color: "#fdba74", font: { size: 9 } },
            grid: { drawOnChartArea: false },
          },
        },
        plugins: {
          legend: { labels: { color: "#cbd5e1", font: { size: 10 }, boxWidth: 10 } },
        },
      },
    });
  }

  // Temporal Chart 2: Active Connections (3050) & Disk I/O (MB/s)
  const ctx2 = document.getElementById("chartTimeConnsIo")?.getContext("2d");
  if (ctx2) {
    if (timeConnsIoChart) timeConnsIoChart.destroy();
    timeConnsIoChart = new Chart(ctx2, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Sessões Porta 3050",
            data: connData,
            borderColor: "#7dd3fc",
            backgroundColor: "rgba(125, 211, 252, 0.16)",
            borderWidth: 2,
            pointRadius: 1.5,
            tension: 0.35,
            fill: true,
            yAxisID: "y",
          },
          {
            label: "I/O Disco (MB/s)",
            data: ioData,
            borderColor: "#a7f3d0",
            borderDash: [4, 3],
            borderWidth: 1.8,
            pointRadius: 1.5,
            tension: 0.35,
            fill: false,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: commonScaleX,
          y: {
            position: "left",
            ticks: { color: "#bae6fd", font: { size: 9 } },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
          y1: {
            position: "right",
            ticks: { color: "#a7f3d0", font: { size: 9 } },
            grid: { drawOnChartArea: false },
          },
        },
        plugins: {
          legend: { labels: { color: "#cbd5e1", font: { size: 10 }, boxWidth: 10 } },
        },
      },
    });
  }

  // Temporal Chart 3: Transaction Gap (Next - OAT) & Latency (ms)
  const ctx3 = document.getElementById("chartTimeTxGap")?.getContext("2d");
  if (ctx3) {
    if (timeTxGapChart) timeTxGapChart.destroy();
    timeTxGapChart = new Chart(ctx3, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Gap Transações (Next - OAT)",
            data: gapData,
            borderColor: "#c4b5fd",
            backgroundColor: "rgba(196, 181, 253, 0.16)",
            borderWidth: 2,
            pointRadius: 1.5,
            tension: 0.35,
            fill: true,
            yAxisID: "y",
          },
          {
            label: "Latência SSH (ms)",
            data: latData,
            borderColor: "#fde047",
            borderWidth: 1.8,
            pointRadius: 1.5,
            tension: 0.35,
            fill: false,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: commonScaleX,
          y: {
            position: "left",
            ticks: { color: "#ddd6fe", font: { size: 9 } },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
          y1: {
            position: "right",
            ticks: { color: "#fef08a", font: { size: 9 } },
            grid: { drawOnChartArea: false },
          },
        },
        plugins: {
          legend: { labels: { color: "#cbd5e1", font: { size: 10 }, boxWidth: 10 } },
        },
      },
    });
  }
}

function renderTelemetryCharts(info) {
  if (typeof Chart === "undefined") return;

  const mem = info.memory || {
    firebird_rss_mb: 2048,
    os_cache_mb: 6144,
    other_processes_mb: 1536,
    ram_free_mb: 6656,
    firebird_pct: 12.5,
  };

  // Doughnut Chart: Memory Allocation
  const ctxMem = document.getElementById("chartMemory")?.getContext("2d");
  if (ctxMem) {
    if (memoryChartInstance) memoryChartInstance.destroy();
    memoryChartInstance = new Chart(ctxMem, {
      type: "doughnut",
      data: {
        labels: ["Firebird Engine (RSS)", "Page Cache Linux (.fdb)", "Outros Processos SO", "RAM Livre"],
        datasets: [
          {
            data: [mem.firebird_rss_mb, mem.os_cache_mb, mem.other_processes_mb, mem.ram_free_mb],
            backgroundColor: [
              "rgba(0, 168, 150, 0.90)", // Venosan Teal (Firebird)
              "rgba(125, 211, 252, 0.82)", // Pastel Sky (Linux Cache)
              "rgba(253, 186, 116, 0.80)", // Pastel Peach (Other)
              "rgba(196, 181, 253, 0.35)", // Soft Lavender (Free)
            ],
            borderColor: "#09131c",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: "66%",
        plugins: {
          legend: {
            position: "right",
            labels: { color: "#cbd5e1", font: { size: 10, family: "Inter" }, boxWidth: 10 },
          },
        },
      },
    });
  }

  // Bar Chart: Table Density vs Garbage Backversions
  const ctxTbl = document.getElementById("chartTables")?.getContext("2d");
  if (ctxTbl) {
    if (tablesChartInstance) tablesChartInstance.destroy();
    const tbls = info.table_distribution || [];
    tablesChartInstance = new Chart(ctxTbl, {
      type: "bar",
      data: {
        labels: tbls.map((t) => t.table.replace("_VENOSAN", "")),
        datasets: [
          {
            label: "Registros Ativos (Milhares)",
            data: tbls.map((t) => t.records_k),
            backgroundColor: "rgba(0, 168, 150, 0.78)",
            borderRadius: 5,
          },
          {
            label: "Lixo / Backversions (Milhares)",
            data: tbls.map((t) => t.garbage_k),
            backgroundColor: "rgba(251, 146, 60, 0.88)",
            borderRadius: 5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            ticks: { color: "#94a3b8", font: { size: 9, family: "JetBrains Mono" } },
            grid: { display: false },
          },
          y: {
            ticks: { color: "#94a3b8", font: { size: 10 } },
            grid: { color: "rgba(148, 163, 184, 0.1)" },
          },
        },
        plugins: {
          legend: {
            labels: { color: "#cbd5e1", font: { size: 10, family: "Inter" }, boxWidth: 10 },
          },
        },
      },
    });
  }

  // Horizontal Bar Chart: Server Saturation
  const ctxSrv = document.getElementById("chartServerHealth")?.getContext("2d");
  if (ctxSrv) {
    if (serverHealthChartInstance) serverHealthChartInstance.destroy();
    const cpuPct = info.cpu_load_pct || 15;
    const fbRamPct = mem.firebird_pct || 18;
    const diskPct = info.disk_used_pct || 35;
    const connPct = Math.min(100, Math.round(((info.active_connections || 10) / 150) * 100));

    serverHealthChartInstance = new Chart(ctxSrv, {
      type: "bar",
      data: {
        labels: ["CPU Host %", "RAM Banco %", "Disco /dados %", "Lotação 3050 %"],
        datasets: [
          {
            label: "% Utilizado",
            data: [cpuPct, fbRamPct, diskPct, connPct],
            backgroundColor: [
              cpuPct > 80 ? "rgba(248, 113, 113, 0.85)" : "rgba(0, 168, 150, 0.85)",
              "rgba(125, 211, 252, 0.85)",
              diskPct > 85 ? "rgba(248, 113, 113, 0.88)" : "rgba(196, 181, 253, 0.82)",
              "rgba(253, 224, 71, 0.78)",
            ],
            borderRadius: 6,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            max: 100,
            ticks: { color: "#94a3b8", font: { size: 10 } },
            grid: { color: "rgba(148, 163, 184, 0.1)" },
          },
          y: {
            ticks: { color: "#e2e8f0", font: { size: 10, family: "Inter" } },
            grid: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
        },
      },
    });
  }
}

function renderTelemetryServices(services) {
  const grid = document.getElementById("telemetry-services-grid");
  if (!grid) return;

  grid.innerHTML = services
    .map((s) => {
      const isOk = s.status === "active";
      const cardCls = isOk ? "pastel-card-safe" : "warm-card-io";
      const dotCls = isOk ? "bg-[#00a896] pulse-green" : "bg-amber-400";
      const badgeTxt = isOk ? "OPERACIONAL" : "VERIFICAR";
      const badgeCls = isOk
        ? "bg-teal-300/15 text-teal-200 border-teal-300/30"
        : "bg-amber-500/20 text-amber-200 border-amber-400/40";

      return `
        <div class="${cardCls} rounded-xl p-3.5 flex flex-col justify-between gap-2">
          <div>
            <div class="flex items-center justify-between gap-1.5">
              <span class="inline-flex items-center gap-1.5 text-xs font-bold text-white">
                <span class="w-2 h-2 rounded-full ${dotCls}"></span>
                ${escapeHtml(s.name)}
              </span>
              <span class="px-2 py-0.5 rounded-full text-[9px] font-bold border ${badgeCls}">
                ${badgeTxt}
              </span>
            </div>
            <p class="text-[11px] font-mono-code text-teal-200/90 mt-1 truncate">${escapeHtml(s.unit)}</p>
          </div>
          <p class="text-[11px] text-slate-300/85 leading-snug pt-1.5 border-t border-slate-800/80">
            ${escapeHtml(s.detail)}
          </p>
        </div>`;
    })
    .join("");
}

function syncPipelineDefaults() {
  const prodId = Number(document.getElementById("pipe-prod-host")?.value);
  const testId = Number(document.getElementById("pipe-test-host")?.value);
  const prod = hostsState.find((h) => h.id === prodId);
  const test = hostsState.find((h) => h.id === testId);

  if (prod && document.getElementById("pipe-prod-db")) {
    document.getElementById("pipe-prod-db").value = prod.default_db_path;
    document.getElementById("pipe-prod-bkp-dir").value = prod.default_backup_dir;
  }
  if (test && document.getElementById("pipe-test-bkp-dir")) {
    document.getElementById("pipe-test-bkp-dir").value = test.default_backup_dir;
    document.getElementById("pipe-test-db").value = test.default_db_path;
  }
}

function syncMaintDefaults() {
  const hostId = Number(document.getElementById("maint-host")?.value);
  const host = hostsState.find((h) => h.id === hostId);
  if (host && document.getElementById("maint-db-path")) {
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
    await loadHostTelemetry(hostId);
  } catch (err) {
    appendLocalConsoleLine(`Falha ao verificar Host #${hostId}: ${err}`, "error");
  }
}

async function checkAllHosts() {
  const btn = document.getElementById("btn-check-all");
  btn.disabled = true;
  appendLocalConsoleLine("Verificando conectividade SSH, Firebird e rfunc.so em todos os servidores...", "info");
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
    await loadHostTelemetry();
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
          <td class="py-2 px-3 font-mono-code text-sky-200">${escapeHtml(f.path)}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${escapeHtml(f.size)}</td>
          <td class="py-2 px-3 text-slate-400">${escapeHtml(f.modified)}</td>
          <td class="py-2 px-3 text-right">
            <button onclick="useBackupFile('${escapeHtml(f.path)}')" class="ro-hide-btn px-2 py-0.5 rounded bg-teal-300/20 hover:bg-teal-300 text-teal-200 hover:text-slate-950 text-[11px] font-semibold transition">
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
          <p class="text-base font-bold font-mono-code text-teal-200 mt-0.5">${info.oldest_active}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Next Transaction</span>
          <p class="text-base font-bold font-mono-code text-sky-200 mt-0.5">${info.next_transaction}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Gap (Next - OAT)</span>
          <p class="text-base font-bold font-mono-code ${info.transaction_gap > 20000 ? "text-amber-300" : "text-teal-200"} mt-0.5">${info.transaction_gap}</p>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Memória Firebird RSS</span>
          <p class="text-sm font-semibold text-sky-200 mt-0.5">${info.memory?.firebird_rss_mb || "--"} MB (${info.memory?.firebird_pct || 0}%)</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Disco em Uso</span>
          <p class="text-sm font-semibold text-amber-200 mt-0.5">${escapeHtml(info.disk_used)}</p>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
          <span class="text-[10px] uppercase text-slate-400">Espaço Livre</span>
          <p class="text-sm font-semibold text-teal-200 mt-0.5">${escapeHtml(info.disk_free)}</p>
        </div>
      </div>

      <div>
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Saída Bruta do Header Page (gstat -h • 100% Read-Only)</h4>
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
function handleAuthTypeChange() {
  const authType = document.getElementById("host-auth-type").value;
  const label = document.getElementById("host-secret-label");
  const input = document.getElementById("host-secret");
  const toggleBtn = document.getElementById("btn-toggle-ssh-secret");

  if (authType === "password") {
    label.textContent = "Senha SSH";
    input.type = "password";
    input.placeholder = "Digite a senha do usuário SSH";
    if (input.value === "~/.ssh/id_rsa") {
      input.value = "";
    }
    toggleBtn.classList.remove("hidden");
  } else {
    label.textContent = "Caminho Chave Privada";
    input.type = "text";
    input.placeholder = "~/.ssh/id_rsa";
    if (!input.value) {
      input.value = "~/.ssh/id_rsa";
    }
    toggleBtn.classList.add("hidden");
  }
}

function toggleSshSecretVisibility() {
  const input = document.getElementById("host-secret");
  input.type = input.type === "password" ? "text" : "password";
}

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
    handleAuthTypeChange();
    document.getElementById("host-secret").value = h.secret || (h.auth_type === "password" ? "********" : "~/.ssh/id_rsa");
    document.getElementById("host-fb-user").value = h.fb_user;
    document.getElementById("host-fb-password").value = "********";
    document.getElementById("host-db-path").value = h.default_db_path;
    document.getElementById("host-backup-dir").value = h.default_backup_dir;
    document.getElementById("host-simulated").checked = Boolean(h.is_simulated);
  } else {
    title.textContent = "Cadastrar Novo Servidor Firebird";
    document.getElementById("host-id").value = "";
    document.getElementById("host-auth-type").value = "key";
    handleAuthTypeChange();
    document.getElementById("host-secret").value = "~/.ssh/id_rsa";
    document.getElementById("host-simulated").checked = false;
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
    await loadHostTelemetry();
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
// 3. Backup, Transfer, Restore & Maintenance Jobs
// ---------------------------------------------------------------------------

function selectJobTab(tab) {
  const tabs = ["pipeline", "backup", "transfer", "restore"];
  tabs.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const form = document.getElementById(`form-job-${t}`);
    if (!btn || !form) return;
    const activeCls = t === "pipeline" || t === "backup" ? "job-tab-active-warm" : "job-tab-active-pastel";
    btn.classList.remove("job-tab-active-warm", "job-tab-active-pastel");
    if (t === tab) {
      btn.classList.add(activeCls);
      form.classList.remove("hidden");
    } else {
      form.classList.add("hidden");
    }
  });
}

function updateBackupPreview() {
  const dbPath = document.getElementById("bkp-db-path")?.value || "/dados/producao.fdb";
  const bkpDir = (document.getElementById("bkp-dir")?.value || "/backups").replace(/\/$/, "");
  const comp = document.getElementById("bkp-comp")?.value || "zstd";
  const compLoc = document.getElementById("bkp-comp-location")?.value || "source";
  const noGc = document.getElementById("bkp-nogc")?.checked;
  const verbose = document.getElementById("bkp-verbose")?.checked;

  const flags = ["-b"];
  if (noGc) flags.push("-g");
  if (verbose) flags.push("-v");

  const ext = comp === "zstd" ? ".fbk.zst" : comp === "gzip" ? ".fbk.gz" : ".fbk";
  let pipe = "";
  if (compLoc !== "source") {
    const modeLabel = compLoc === "middle_stream" ? "Streaming" : "2-Etapas";
    pipe = `stdout  -->  [Offload ${modeLabel} na Máq. Aplicação: ${comp} -> data/staging/base_${ext}]`;
  } else {
    pipe =
      comp === "zstd"
        ? `stdout | zstd -1 -T0 > ${bkpDir}/base_$(date +%Y%m%d_%H%M)${ext}`
        : comp === "gzip"
          ? `stdout | gzip -1 > ${bkpDir}/base_$(date +%Y%m%d_%H%M)${ext}`
          : `${bkpDir}/base_$(date +%Y%m%d_%H%M)${ext}`;
  }

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
    compression_location: document.getElementById("bkp-comp-location")?.value || "source",
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
    compression_location: document.getElementById("pipe-comp-location")?.value || "source",
    no_gc: document.getElementById("pipe-nogc").checked,
    transfer_method: document.getElementById("pipe-transfer").value,
    run_restore: document.getElementById("pipe-restore") ? document.getElementById("pipe-restore").checked : true,
    run_gfix: document.getElementById("pipe-gfix").checked,
  };
  await triggerJobEndpoint("/api/jobs/full-pipeline", payload);
}

// ---------------------------------------------------------------------------
// 3.5 Agendamentos Automáticos (24/7)
// ---------------------------------------------------------------------------

async function loadSchedules() {
  const tbody = document.getElementById("schedules-tbody");
  if (!tbody) return;
  try {
    const res = await fetch("/api/schedules");
    if (!res.ok) return;
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-slate-500">Nenhum agendamento cadastrado.</td></tr>`;
      return;
    }

    const hostName = (id) => {
      const h = hostsState.find((x) => x.id === id);
      return h ? escapeHtml(h.name) : `#${id}`;
    };

    const locBadge = (loc) => {
      if (loc === "middle_stream") {
        return `<span class="px-2 py-0.5 rounded bg-teal-400/15 text-teal-200 border border-teal-400/30 text-[10px] font-semibold">Offload Streaming</span>`;
      }
      if (loc === "middle_staged") {
        return `<span class="px-2 py-0.5 rounded bg-sky-400/15 text-sky-200 border border-sky-400/30 text-[10px] font-semibold">Offload 2-Etapas</span>`;
      }
      return `<span class="px-2 py-0.5 rounded bg-amber-400/15 text-amber-200 border border-amber-400/30 text-[10px] font-semibold">Na Origem</span>`;
    };

    tbody.innerHTML = rows
      .map((s) => {
        const statusBadge = s.enabled
          ? `<span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">ATIVO</span>`
          : `<span class="px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 text-[10px] font-bold">PAUSADO</span>`;
        const lastRun = s.last_run_at ? new Date(s.last_run_at).toLocaleString("pt-BR") : "Nunca";
        return `
          <tr class="hover:bg-slate-800/40 transition">
            <td class="py-3 px-4 font-semibold text-white">${escapeHtml(s.name)}</td>
            <td class="py-3 px-4 font-mono-code text-teal-200">${escapeHtml(s.cron_expr)}</td>
            <td class="py-3 px-4 text-slate-300">${hostName(s.prod_host_id)} &rarr; ${hostName(s.test_host_id)}</td>
            <td class="py-3 px-4 space-x-1">
              <span class="font-mono-code text-slate-200">${escapeHtml(s.compression)}</span>
              ${locBadge(s.compression_location || "source")}
            </td>
            <td class="py-3 px-4 text-[11px] text-slate-300">
              ${s.no_gc ? "-g" : "GC"} | ${s.run_restore !== false ? "Restore" : "Só Cópia"}${s.run_gfix && s.run_restore !== false ? "+gfix" : ""} | ${s.retention_days}d
            </td>
            <td class="py-3 px-4 text-slate-400">${escapeHtml(lastRun)}</td>
            <td class="py-3 px-4">${statusBadge}</td>
            <td class="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
              <button onclick="runScheduleNow(${s.id})" class="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 text-amber-200 text-[11px] font-semibold">Executar</button>
              <button onclick="toggleSchedule(${s.id})" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]">${s.enabled ? "Pausar" : "Ativar"}</button>
              <button onclick="deleteSchedule(${s.id})" class="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 text-[11px]">Excluir</button>
            </td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    console.error("Erro ao carregar agendamentos:", err);
  }
}

function openScheduleModal() {
  if (!hostsState.length) {
    alert("Cadastre pelo menos um servidor (ou ative o Modo Demonstração) antes de criar um agendamento.");
    return;
  }
  document.getElementById("schedule-form")?.reset();
  document.getElementById("schedule-modal")?.classList.remove("hidden");
}

function closeScheduleModal() {
  document.getElementById("schedule-modal")?.classList.add("hidden");
}

async function saveSchedule(event) {
  event.preventDefault();
  const payload = {
    name: document.getElementById("sched-name").value.trim(),
    cron_expr: document.getElementById("sched-cron").value.trim(),
    prod_host_id: Number(document.getElementById("sched-prod-host").value),
    test_host_id: Number(document.getElementById("sched-test-host").value),
    compression: document.getElementById("sched-compression").value,
    compression_location: document.getElementById("sched-comp-location").value,
    no_gc: document.getElementById("sched-nogc").checked,
    run_restore: document.getElementById("sched-restore").checked,
    run_gfix: document.getElementById("sched-gfix").checked,
    retention_days: Number(document.getElementById("sched-retention").value) || 0,
    webhook_url: document.getElementById("sched-webhook").value.trim(),
    enabled: true,
  };
  const res = await fetch("/api/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    closeScheduleModal();
    await loadSchedules();
  } else {
    const err = await res.json();
    alert(`Erro ao salvar agendamento: ${err.detail || "Verifique os dados"}`);
  }
}

async function toggleSchedule(id) {
  await fetch(`/api/schedules/${id}/toggle`, { method: "POST" });
  await loadSchedules();
}

async function runScheduleNow(id) {
  const res = await fetch(`/api/schedules/${id}/run`, { method: "POST" });
  if (res.ok) {
    const data = await res.json();
    appendLocalConsoleLine(`Agendamento #${id} disparado manualmente (Execução #${data.execution_id}).`, "info");
    await loadSchedules();
  } else {
    alert("Falha ao executar agendamento.");
  }
}

async function deleteSchedule(id) {
  if (!confirm("Remover este agendamento?")) return;
  await fetch(`/api/schedules/${id}`, { method: "DELETE" });
  await loadSchedules();
}

// ---------------------------------------------------------------------------
// 3.6 SQL Utils (Read-Only Troubleshooting & SQL Livre)
// ---------------------------------------------------------------------------

const SQL_UTILS_PRESETS = {
  stuck_tx: {
    desc: "Lista as transações mais antigas em aberto para identificar qual IP ou processo está segurando o OAT e aumentando o Gap.",
    sql: `SELECT FIRST 25\n  t.MON$TRANSACTION_ID,\n  a.MON$ATTACHMENT_ID,\n  a.MON$USER,\n  a.MON$REMOTE_ADDRESS,\n  a.MON$REMOTE_PROCESS,\n  t.MON$TIMESTAMP,\n  t.MON$STATE\nFROM MON$TRANSACTIONS t\nJOIN MON$ATTACHMENTS a ON a.MON$ATTACHMENT_ID = t.MON$ATTACHMENT_ID\nORDER BY t.MON$TRANSACTION_ID ASC`,
  },
  active_sql: {
    desc: "Exibe as instruções SQL em execução ativa neste momento (útil para achar relatórios ou queries pesadas).",
    sql: `SELECT FIRST 25\n  s.MON$STATEMENT_ID,\n  a.MON$USER,\n  a.MON$REMOTE_ADDRESS,\n  a.MON$REMOTE_PROCESS,\n  s.MON$TIMESTAMP,\n  LEFT(COALESCE(s.MON$SQL_TEXT, ''), 180) AS SQL_TEXT\nFROM MON$STATEMENTS s\nJOIN MON$ATTACHMENTS a ON a.MON$ATTACHMENT_ID = s.MON$ATTACHMENT_ID\nWHERE s.MON$STATE = 1\nORDER BY s.MON$TIMESTAMP ASC`,
  },
  connections: {
    desc: "Lista todas as conexões ativas no Firebird (porta 3050), com usuário, IP e aplicativo cliente.",
    sql: `SELECT FIRST 100\n  a.MON$ATTACHMENT_ID,\n  a.MON$USER,\n  a.MON$REMOTE_ADDRESS,\n  a.MON$REMOTE_PROCESS,\n  a.MON$TIMESTAMP\nFROM MON$ATTACHMENTS a\nWHERE a.MON$SYSTEM_FLAG = 0\nORDER BY a.MON$TIMESTAMP ASC`,
  },
  table_io: {
    desc: "Mostra as tabelas com mais leituras sequenciais (table scans) e alterações na sessão/instância atual.",
    sql: `SELECT FIRST 25\n  TRIM(r.RDB$RELATION_NAME) AS TABELA,\n  COALESCE(s.MON$RECORD_SEQ_READS, 0) AS SEQ_READS,\n  COALESCE(s.MON$RECORD_IDX_READS, 0) AS IDX_READS,\n  COALESCE(s.MON$RECORD_INSERTS, 0) AS INSERTS,\n  COALESCE(s.MON$RECORD_UPDATES, 0) AS UPDATES,\n  COALESCE(s.MON$RECORD_DELETES, 0) AS DELETES\nFROM RDB$RELATIONS r\nLEFT JOIN MON$TABLE_STATS s ON s.MON$TABLE_STAT_ID = r.RDB$RELATION_ID\nWHERE r.RDB$SYSTEM_FLAG = 0 AND r.RDB$VIEW_BLR IS NULL\nORDER BY COALESCE(s.MON$RECORD_SEQ_READS, 0) DESC`,
  },
  memory_top: {
    desc: "Lista as conexões/anexos que mais consomem memória RAM dentro do motor Firebird.",
    sql: `SELECT FIRST 20\n  a.MON$ATTACHMENT_ID,\n  a.MON$USER,\n  a.MON$REMOTE_ADDRESS,\n  a.MON$REMOTE_PROCESS,\n  CAST(m.MON$MEMORY_USED / 1048576.0 AS NUMERIC(12,2)) AS MB_USADO\nFROM MON$MEMORY_USAGE m\nJOIN MON$ATTACHMENTS a ON a.MON$ATTACHMENT_ID = m.MON$STAT_ID\nWHERE m.MON$STAT_GROUP = 1\nORDER BY m.MON$MEMORY_USED DESC`,
  },
  db_header: {
    desc: "Retorna OIT, OAT, Next TX, Page Size, Buffers, Sweep Interval e Forced Writes direto da tabela MON$DATABASE.",
    sql: `SELECT\n  d.MON$PAGE_SIZE,\n  d.MON$PAGE_BUFFERS,\n  d.MON$OLDEST_TRANSACTION AS OIT,\n  d.MON$OLDEST_ACTIVE AS OAT,\n  d.MON$NEXT_TRANSACTION AS NEXT_TX,\n  (d.MON$NEXT_TRANSACTION - d.MON$OLDEST_ACTIVE) AS GAP_NEXT_OAT,\n  d.MON$SWEEP_INTERVAL,\n  d.MON$FORCED_WRITES\nFROM MON$DATABASE d`,
  },
};

function applySqlUtilsPreset() {
  const key = document.getElementById("sqlu-preset")?.value || "stuck_tx";
  const preset = SQL_UTILS_PRESETS[key];
  if (!preset) return;
  const qEl = document.getElementById("sqlu-query");
  const dEl = document.getElementById("sqlu-preset-desc");
  if (qEl) qEl.value = preset.sql;
  if (dEl) dEl.textContent = preset.desc;
}

function toggleSqluRaw() {
  const tbl = document.getElementById("sqlu-table-wrap");
  const raw = document.getElementById("sqlu-raw-output");
  if (!tbl || !raw) return;
  const showRaw = raw.classList.contains("hidden");
  raw.classList.toggle("hidden", !showRaw);
  tbl.classList.toggle("hidden", showRaw);
}

async function runSqlUtilsQuery() {
  const hostId = document.getElementById("sqlu-host")?.value;
  const sql = document.getElementById("sqlu-query")?.value?.trim();
  const btn = document.getElementById("btn-run-sqlu");
  const statusBar = document.getElementById("sqlu-status-bar");
  const statusText = document.getElementById("sqlu-status-text");
  const tableWrap = document.getElementById("sqlu-table-wrap");
  const thead = document.getElementById("sqlu-thead");
  const tbody = document.getElementById("sqlu-tbody");
  const rawEl = document.getElementById("sqlu-raw-output");

  if (!hostId) {
    alert("Cadastre um servidor (ou ative o Modo Demonstração) primeiro.");
    return;
  }
  if (!sql) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Executando...";
  }
  try {
    const res = await fetch(`/api/hosts/${hostId}/sql-utils`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (statusBar) statusBar.classList.remove("hidden");
      if (statusText) statusText.innerHTML = `<span class="text-rose-300 font-semibold">${escapeHtml(data.detail || "Erro na consulta")}</span>`;
      if (tableWrap) tableWrap.classList.add("hidden");
      if (rawEl) rawEl.classList.add("hidden");
      return;
    }

    if (statusBar) statusBar.classList.remove("hidden");
    if (statusText) {
      statusText.innerHTML = `<span class="text-emerald-300 font-semibold">${data.row_count} linha(s)</span> retornadas em <span class="font-mono-code text-teal-200">${data.duration_ms} ms</span> (READ ONLY)`;
    }
    if (rawEl) {
      rawEl.textContent = data.raw_output || "(sem saída)";
      rawEl.classList.add("hidden");
    }

    const cols = data.columns || [];
    const rows = data.rows || [];
    if (cols.length && rows.length) {
      thead.innerHTML = `<tr>${cols.map((c) => `<th class="py-2.5 px-3 whitespace-nowrap">${escapeHtml(c)}</th>`).join("")}</tr>`;
      tbody.innerHTML = rows
        .map(
          (r) => `<tr class="hover:bg-slate-900/60">${cols.map((c) => `<td class="py-2 px-3 text-slate-200 whitespace-nowrap">${escapeHtml(r[c] ?? "")}</td>`).join("")}</tr>`
        )
        .join("");
      tableWrap.classList.remove("hidden");
    } else {
      tableWrap.classList.add("hidden");
      if (rawEl) rawEl.classList.remove("hidden");
    }
  } catch (err) {
    alert(`Erro de rede ao executar consulta: ${err}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "▶ Executar Consulta (READ ONLY)";
    }
  }
}

async function quickTriggerFullPipeline() {
  selectJobTab("pipeline");
  await submitFullPipeline(null);
}

// ---------------------------------------------------------------------------
// 4. Offline Database Analyzer & Optimizer Lab
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
      ? "text-teal-200 border-teal-300/40 bg-teal-300/15"
      : rep.health_score >= 55
        ? "text-amber-200 border-amber-400/40 bg-amber-400/15"
        : "text-rose-200 border-rose-500/50 bg-rose-500/20";

  const recCards = (rep.recommendations || [])
    .map((r) => {
      const cardCls =
        r.severity === "critical"
          ? "hot-card-critical"
          : r.severity === "warning"
            ? "warm-card-io"
            : "pastel-card-safe";

      const badge =
        r.severity === "critical"
          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-rose-500 text-white">Crítico • Reparo</span>`
          : r.severity === "warning"
            ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-500/25 text-amber-200 border border-amber-400/40">Recomendado</span>`
            : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-teal-300/20 text-teal-200 border border-teal-300/30">OK • Saudável</span>`;

      const actionBtn = r.action_id
        ? `<button onclick="runOfflineOptimizationAction('${r.action_id}')" class="mt-3 w-full py-2 px-3 rounded-xl bg-white/10 hover:bg-teal-300 text-white hover:text-slate-950 border border-white/20 text-xs font-bold transition">
             ⚡ ${escapeHtml(r.action_label)}
           </button>`
        : "";

      return `
        <div class="rounded-2xl ${cardCls} p-4 flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between gap-2 mb-2">
              <span class="text-[11px] font-semibold text-slate-300 uppercase">${escapeHtml(r.category)}</span>
              ${badge}
            </div>
            <h4 class="text-sm font-bold text-white">${escapeHtml(r.title)}</h4>
            <p class="text-xs text-slate-300/90 mt-1.5 leading-relaxed">${escapeHtml(r.detail)}</p>
          </div>
          ${actionBtn}
        </div>`;
    })
    .join("");

  const tableRows = (rep.tables || [])
    .map((t) => {
      const stBadge =
        t.status === "critical"
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/25 text-rose-200">Precisa Sweep</span>`
          : t.status === "warning"
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-200">Lixo Moderado</span>`
            : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-300/20 text-teal-200">Limpa</span>`;
      return `
        <tr class="border-b border-slate-800/70">
          <td class="py-2 px-3 font-mono-code font-semibold text-white">${escapeHtml(t.table_name)}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${Number(t.total_records).toLocaleString("pt-BR")}</td>
          <td class="py-2 px-3 font-mono-code font-bold ${t.backversions > 10000 ? "text-amber-300" : "text-teal-200"}">${Number(t.backversions).toLocaleString("pt-BR")}</td>
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
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/25 text-rose-200">Depth ${i.depth} (Rebuild 16K)</span>`
          : i.depth === 3
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-200">Depth 3 (Recalcular)</span>`
            : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-300/20 text-teal-200">Depth ${i.depth} (Ótimo)</span>`;
      return `
        <tr class="border-b border-slate-800/70">
          <td class="py-2 px-3 font-mono-code font-semibold text-white">${escapeHtml(i.index_name)}</td>
          <td class="py-2 px-3 font-mono-code font-bold ${i.depth >= 3 ? "text-amber-300" : "text-teal-200"}">${i.depth}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${Number(i.nodes).toLocaleString("pt-BR")}</td>
          <td class="py-2 px-3 font-mono-code text-slate-300">${i.dup_ratio_pct}%</td>
          <td class="py-2 px-3 text-right">${stBadge}</td>
        </tr>`;
    })
    .join("");

  container.innerHTML = `
    <div class="rounded-2xl bg-slate-950/90 border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
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
            Arquivo: <span class="text-sky-200">${escapeHtml(rep.db_path)}</span> | Page Size: <span class="text-white">${rep.page_size}</span> | ODS: <span class="text-white">${escapeHtml(rep.ods_version)}</span> | Gap OAT-OIT: <span class="text-white">${Number(rep.gap_oat_oit).toLocaleString("pt-BR")}</span>
          </p>
        </div>
      </div>

      <button
        onclick="runOfflineOptimizationAction('all')"
        class="px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#00a896] to-teal-300 hover:from-teal-300 hover:to-emerald-300 text-slate-950 text-xs font-extrabold shadow-lg shadow-teal-400/20 flex items-center gap-2 transition"
      >
        <span>⚡ Aplicar Todas as Correções neste Arquivo Offline (1-Clique)</span>
      </button>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      ${recCards}
    </div>

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

// Maintenance Routines
async function runMaintenanceJob(jobId) {
  const hostId = Number(document.getElementById("maint-host").value);
  const dbPath = document.getElementById("maint-db-path").value.trim();
  const host = hostsState.find((h) => h.id === hostId);
  const confirmDowntime = document.getElementById("maint-confirm-downtime")?.checked || false;
  const linuxMode = document.getElementById("maint-linux-mode")?.value || "audit_only";

  if (jobId === "job_full_rebuild" && !confirmDowntime) {
    appendLocalConsoleLine(
      "ATENÇÃO CRÍTICA: O job_full_rebuild exige parada da base (gfix -shut). Marque a caixa 'Autorizar Parada (Shutdown)' no card vermelho antes de disparar.",
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
    const statusEl = document.getElementById("terminal-status-text");
    if (statusEl) statusEl.textContent = "Executando Job remoto via SSH...";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLocalConsoleLine(`BLOQUEIO / ERRO: ${data.detail || "Falha"}`, "error");
      alert(data.detail || "Operação não permitida.");
      return;
    }
    if (data.output_file && document.getElementById("xfer-file")) {
      document.getElementById("xfer-file").value = data.output_file;
    }
    await refreshAllData();
  } catch (err) {
    appendLocalConsoleLine(`Falha de comunicação com a API: ${err}`, "error");
  }
}

// ---------------------------------------------------------------------------
// 5. Real-Time WebSocket Terminal Console
// ---------------------------------------------------------------------------

function connectWebSocket() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}/ws/logs`;
  wsConnection = new WebSocket(wsUrl);

  wsConnection.onopen = () => {
    const dot = document.getElementById("ws-dot");
    const txt = document.getElementById("ws-text");
    if (dot) dot.className = "w-2.5 h-2.5 rounded-full bg-[#00a896] pulse-green";
    if (txt) txt.textContent = "Stream Ativo (WSS/WS)";
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
      const stEl = document.getElementById("terminal-status-text");
      if (stEl) {
        stEl.textContent = `Job #${msg.execution_id} (${msg.job_title}): ${statusLabel} em ${msg.duration_seconds?.toFixed(2) || 0}s`;
      }
      await refreshAllData();
      await loadHostTelemetry();
    }
  };

  wsConnection.onclose = () => {
    const dot = document.getElementById("ws-dot");
    const txt = document.getElementById("ws-text");
    if (dot) dot.className = "w-2.5 h-2.5 rounded-full bg-rose-400";
    if (txt) txt.textContent = "Reconectando Stream...";
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, 2500);
  };
}

function appendLocalConsoleLine(text, level = "info") {
  const now = new Date().toTimeString().slice(0, 8);
  consoleLogs.push({
    type: "log",
    timestamp: now,
    host: "CommandCenter",
    step: "SYS",
    level,
    line: text,
  });
  renderConsoleLines();
}

function renderConsoleLines() {
  const container = document.getElementById("terminal-output");
  if (!container) return;
  const filter = document.getElementById("console-filter")?.value || "all";

  const filtered = consoleLogs.filter((item) => {
    if (filter === "cmd") return item.level === "cmd";
    if (filter === "warn_err") return item.level === "warn" || item.level === "error";
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div class="text-slate-500 italic py-6 text-center">
        Console pronto. Dispare um Job de Backup/Restore, uma Rotina de Manutenção ou um Raio-X Offline para acompanhar a saída em tempo real.
      </div>`;
    document.getElementById("terminal-line-count").textContent = "0 linhas";
    return;
  }

  container.innerHTML = filtered
    .map((item) => {
      let colorClass = "text-slate-200";
      let badgeClass = "bg-slate-800 text-slate-300";

      if (item.level === "cmd") {
        colorClass = "text-sky-200 font-semibold";
        badgeClass = "bg-sky-300/20 text-sky-200 border border-sky-300/30";
      } else if (item.level === "success") {
        colorClass = "text-teal-200 font-medium";
        badgeClass = "bg-teal-300/20 text-teal-200 border border-teal-300/30";
      } else if (item.level === "warn") {
        colorClass = "text-amber-200 font-medium";
        badgeClass = "bg-amber-400/20 text-amber-200 border border-amber-400/30";
      } else if (item.level === "error") {
        colorClass = "text-rose-300 font-semibold";
        badgeClass = "bg-rose-500/25 text-rose-200 border border-rose-500/40";
      }

      const stepTag = item.step
        ? `<span class="px-1.5 py-0.2 rounded text-[10px] ${badgeClass}">${escapeHtml(item.step)}</span>`
        : "";

      return `
        <div class="log-line flex items-start gap-2 py-0.5 px-1.5 rounded">
          <span class="text-slate-500 shrink-0 select-none">[${escapeHtml(item.timestamp || "")}]</span>
          <span class="text-teal-300/90 shrink-0 font-medium">[${escapeHtml(item.host || "Host")}]</span>
          ${stepTag}
          <span class="${colorClass}">${escapeHtml(item.line)}</span>
        </div>`;
    })
    .join("");

  document.getElementById("terminal-line-count").textContent = `${filtered.length} linhas`;

  if (document.getElementById("console-autoscroll")?.checked) {
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
// 6. Execution History & Log Viewer Modal
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
            Nenhuma rotina executada ainda.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = list
      .map((ex) => {
        let statusBadge = "";
        if (ex.status === "success") {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-teal-300/15 text-teal-200 border border-teal-300/30">Sucesso</span>`;
        } else if (ex.status === "warning") {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-400/20 text-amber-200 border border-amber-400/30">Alerta</span>`;
        } else if (ex.status === "error") {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/20 text-rose-200 border border-rose-500/40">Erro</span>`;
        } else {
          statusBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-sky-300/15 text-sky-200 border border-sky-300/30 animate-pulse">Executando...</span>`;
        }

        const hostsLabel =
          ex.source_host_name && ex.target_host_name
            ? `${escapeHtml(ex.source_host_name)} &rarr; ${escapeHtml(ex.target_host_name)}`
            : escapeHtml(ex.source_host_name || ex.target_host_name || "-");

        const duration = ex.duration_seconds != null ? `${ex.duration_seconds}s` : "...";

        return `
          <tr class="hover:bg-slate-800/40 transition">
            <td class="py-3 px-4 font-mono-code font-semibold text-teal-200">#${ex.id}</td>
            <td class="py-3 px-4 text-slate-300 whitespace-nowrap">${formatIsoDate(ex.started_at)}</td>
            <td class="py-3 px-4 font-semibold text-white">${escapeHtml(ex.job_title)}</td>
            <td class="py-3 px-4 text-slate-300">${hostsLabel}</td>
            <td class="py-3 px-4 text-slate-300 max-w-md truncate" title="${escapeHtml(ex.summary || "")}">
              ${escapeHtml(ex.summary || ex.command_preview || "")}
            </td>
            <td class="py-3 px-4 font-mono-code text-slate-300">${duration}</td>
            <td class="py-3 px-4">${statusBadge}</td>
            <td class="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
              <button onclick="openLogModal(${ex.id})" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium transition">
                Ver Log
              </button>
              <a href="/api/executions/${ex.id}/download" download class="inline-block px-2.5 py-1 rounded-lg bg-sky-300/15 hover:bg-sky-300/25 text-sky-200 border border-sky-300/30 text-[11px] font-medium transition">
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
