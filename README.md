# Firebird Command Center (`firebird-mnt`) — Venosan Brasil

<p align="center">
  <img src="frontend/assets/venosan-logo-card.png" height="72" alt="Venosan • Lohmann & Rauscher" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="frontend/assets/firebird-logo.png" height="64" alt="Firebird Database" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Venosan_Brasil-Firebird_Command_Center-00a896?style=for-the-badge" alt="Venosan" />
  <img src="https://img.shields.io/badge/Firebird_Database-2.5_%7C_3.0_%7C_4.0+-f97316?style=for-the-badge&logo=firebird&logoColor=white" alt="Firebird" />
  <img src="https://img.shields.io/badge/HTTPS_%2F_TLS-Auto_Self--Signed_(:8443)-10b981?style=for-the-badge&logo=letsencrypt&logoColor=white" alt="HTTPS" />
  <img src="https://img.shields.io/badge/Docker_%26_Proxmox-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
</p>

O **Firebird Command Center** é a central de comando, telemetria temporal e automação de banco de dados desenvolvida sob medida com a identidade visual da **Venosan Brasil** (`#00a896` Swiss Quality Teal + emblema Firebird Phoenix em marca d'água) para operação crítica de servidores Linux rodando **Firebird Database**.

---

## Destaques da Arquitetura v2.0

1. **HTTPS Nativo com Certificado Autoassinado Automático (`:8443`):**
   - No primeiro boot, o container gera automaticamente um par de certificados X.509 (`cert.pem` e `key.pem` válidos por 10 anos com SAN para o IP do host e `localhost`) e sobe o servidor criptografado em **`https://<IP>:8443`** (mantendo também a porta `:8000` disponível).
2. **Perfis de Acesso (`admin` vs `firebird-ro` para TV da Sala NOC):**
   - **`admin` (Administrador Total / DBA):** Acesso completo para gerenciar servidores, disparar backups quentes, restores de homologação, rotinas de manutenção e Laboratório Offline.
   - **`firebird-ro` (Somente Leitura / Modo TV Sala NOC):** Conta bloqueada no backend (`HTTP 403` para qualquer escrita ou disparo de job) que ativa automaticamente o **Modo TV NOC** na interface — ocultando formulários operacionais, ativando o relógio digital de parede e atualizando os **Gráficos Temporais** automaticamente a cada **10 segundos** para exibição contínua na TV da sala de TI.
3. **Gráficos Temporais no Decorrer do Tempo (Time-Series Telemetry):**
   - Armazena amostras históricas no SQLite (`telemetry_samples`) e plota em tempo real a evolução de:
     - **Memória RSS do Processo Firebird (MB) & Carga de CPU (%) no tempo**
     - **Sessões ERP Ativas na Porta `3050` & Taxa de I/O de Disco (MB/s) no tempo**
     - **Gap de Transações (`Next - OAT` / `OAT - OIT`) & Latência SSH (ms) no tempo**
   - Monitora em tempo real os **5 Serviços Críticos do Ecossistema Firebird**: `Firebird Engine`, **`Biblioteca UDF rfunc (/opt/firebird/UDF/rfunc.so)`**, `Firebird Guardian (fbguard)`, `Socket GDS_DB (Porta 3050/TCP)` e `SSD fstrim.timer / noatime`.

---

## Galeria de Telas do Firebird Command Center

### 1. Central de Telemetria Temporal & Modo TV Sala NOC (`firebird-ro`)
![Firebird Command Center - Telemetria Temporal e Modo TV NOC](docs/assets/01-command-center-telemetry.svg)

---

### 2. Orquestrador de Backup Quente, Console WebSocket & Manutenção Preventiva (Tons Pastel vs Cores Quentes)
![Orquestrador de Backup e Rotinas de Manutenção](docs/assets/02-maintenance-pastel-vs-hot.svg)

- **Tons Pastel (Menta, Azul Céu e Lavanda):** Operações seguras, *read-only* (`gstat -h`) ou **100% online** (`SET STATISTICS INDEX`).
- **Tons Quentes (Âmbar e Vermelho Carmesim):** Operações de alto I/O (`gbak -b`, `gfix -sweep`) ou **operações críticas que exigem janela de parada** (`job_full_rebuild` com `gfix -shut full`).

---

### 3. Laboratório de Análise & Otimização Offline (`.fdb` Sandbox)
![Laboratório de Análise e Otimização Offline](docs/assets/03-offline-analyzer-lab.svg)

- Importe uma cópia de qualquer arquivo `.fdb` (via **Upload em Stream pelo navegador** ou caminho local) para rodar um Raio-X profundo (`gstat -h -r -i` + `gfix -v -full -n`) com **risco zero para a produção**.
- Receba um **Health Score (0 a 100)** indicando se o arquivo precisa de `gfix -sweep`, recálculo de índices (`Depth >= 3`), `gfix -mend` ou conversão para `Page Size 16384`.

---

## Como Fazer o Deploy em Docker no Linux (1 Comando)

No servidor Linux ou container Proxmox com Docker instalado:

```bash
git clone git@github.com:rgerios/firebird-mnt.git
cd firebird-mnt
chmod +x deploy/docker-deploy.sh
./deploy/docker-deploy.sh
```

### URLs e Credenciais Iniciais

| Perfil | Usuário | Senha Inicial | Permissão / Finalidade |
| :--- | :--- | :--- | :--- |
| **Administrador (DBA)** | `admin` | `Venosan@2026` | Acesso total a servidores, backups, manutenção e laboratório offline |
| **TV Sala NOC (Leitura)** | `firebird-ro` | `VenosanRO@2026` | **Somente Leitura** • Abre direto no **Modo TV NOC** com gráficos temporais auto-refresh (10s) |

- **Acesso HTTPS (Certificado Autoassinado):** `https://<IP_DO_SERVIDOR>:8443/login`
- **Acesso HTTP Alternativo:** `http://<IP_DO_SERVIDOR>:8000/login`
- **Healthcheck:** `https://<IP_DO_SERVIDOR>:8443/api/health`

---

## Documentação Técnica Complementar
- [INFRAMGNT_ARQUITETURA.md](INFRAMGNT_ARQUITETURA.md) — Arquitetura detalhada, topologia SSH/SFTP Relay e estrutura de módulos.
- [ROTINAS_MANUTENCAO.md](ROTINAS_MANUTENCAO.md) — Guia de comandos Firebird (`gstat`, `gfix`, `gbak`, `isql`), tuning de kernel Linux e Laboratório Offline.
