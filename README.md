# InfraMGNT (`firebird-mnt`) — Gestão de Backup, Manutenção & Laboratório Offline Firebird

Painel de controle web centralizado desenvolvido em **FastAPI + Python + TailwindCSS + WebSockets** para automação, proteção e diagnóstico profundo de servidores Linux rodando **Firebird Database** (`2.5` / `3.0` / `4.0+`).

Projetado para rodar em **Container Docker no Linux** ou **Container LXC no Proxmox**, com autenticação criptografada obrigatória e **Travas Hard de Proteção de Produção**.

---

## Principais Módulos e Funcionalidades

### 1. Painel de Servidores Firebird (Hosts SSH)
- Cadastro de servidores classificados por papel (**Produção**, **Teste / Validação**, **Storage Backup**).
- Checagem em tempo real de conectividade TCP/SSH (latência em `ms`) e status do daemon Firebird (`systemctl is-active firebird*`).
- **Inspeção Rápida (`gstat -h` & Disco):** Visualização 100% *read-only* dos contadores `Oldest Transaction (OIT)`, `Oldest Active (OAT)`, `Next Transaction`, *Gap* de transações, uso de disco (`df -h`) e listagem de arquivos `.fbk.zst` remotos.
- **Modo Simulação / Homologação:** Permite homologar fluxos e treinar operadores antes de virar a chave para **SSH Real**.

### 2. Jobs de Backup Quente, Transporte & Validação Física
- **Job 1 — Backup Produção (`gbak -b -g`):** Backup quente com flag `-g` (inibe Garbage Collection na produção para zero impacto aos usuários) e compressão em pipe (`stdout | zstd -1 -T0` ou `gzip`).
- **Job 2 — Transferência entre Servidores (`rsync` / `scp` + Relay SFTP):** Cópia direta entre Servidor A e Servidor B, com fallback automático para **Relay SFTP** caso os servidores não possuam chave SSH mútua.
- **Job 3 — Restore & Validação Física (`gbak -c -rep` + `gfix -v -full -n`):** Descompressão em pipe direto para o `gbak` na máquina de testes seguida de validação física de páginas e índices via `gfix`.
- **Job 4 — Pipeline Completo (1-Clique) & Agendador Cron:** Executa as 4 etapas em sequência (*Backup em A &rarr; Transferência &rarr; Restore em B &rarr; Validação `gfix` &rarr; Limpeza de retenção &rarr; Notificação Webhook*).

### 3. Catálogo de Rotinas de Manutenção Preventiva & Tuning Linux
Conforme documentado em [ROTINAS_MANUTENCAO.md](file:///Users/rgerios/Documents/VenosanBancobkp/ROTINAS_MANUTENCAO.md):
- `job_reindex_stats`: Recálculo online de seletividade de todos os índices ativos (`SET STATISTICS INDEX` via `isql`).
- `job_check_health`: Diagnóstico *read-only* de `OAT`/`OIT` via `gstat -h` e detecção de transações presas.
- `job_clean_sweep`: Limpeza manual de *backversions* (`gfix -sweep`) fora do horário de pico.
- `job_full_rebuild`: Ciclo completo de janela de manutenção (`gfix -shut full` &rarr; `gbak -b` &rarr; `gbak -c` &rarr; `gfix -v` &rarr; `gfix -online`).
- `job_linux_patches`: Auditoria e aplicação de otimizações Linux para Firebird (`noatime,nodiratime` no `/etc/fstab`, `vm.swappiness=10`, `fstrim.timer` para SSD/NVMe e `apt-mark hold firebird*`).

### 4. Laboratório de Análise & Otimização Offline (`.fdb` Sandbox)
Ambiente isolado para importar qualquer arquivo `.fdb` (via **Upload em Stream pelo navegador** ou **Caminho no servidor/container**) e executar um **Raio-X completo sem tocar na produção**:
- Calcula o **Health Score (0 a 100)** da base.
- **Raio-X de Tabelas (`gstat -r`):** Ranking de tabelas com mais lixo acumulado (*backversions*) e fragmentação de páginas (*Average Fill %*).
- **Raio-X de Índices (`gstat -i`):** Identifica árvores B-Tree profundas (`Depth >= 3` ou `Depth >= 4`) e índices com alta taxa de duplicatas.
- **Verificação Física (`gfix -v -full -n`):** Detecta páginas órfãs e registros corrompidos.
- **Otimização Offline em 1 Clique:** Permite aplicar `gfix -sweep`, `SET STATISTICS INDEX`, `gfix -mend` ou **Rebuild Completo para Page Size 16384** diretamente no arquivo isolado.

### 5. Blindagem e Travas Hard de Produção
- **Bloqueio Físico de Restore em Produção:** O backend rejeita (`HTTP 403`) qualquer tentativa de rodar o Job 3 (`gbak -c -rep`) ou otimizações destrutivas apontando para um servidor com papel `Produção` ou para o caminho do `.fdb` de produção.
- **Trava Pré-Backup de Espaço em Disco:** Antes de iniciar o `gbak -b`, verifica via `df -P` se a partição possui espaço livre seguro (< 90% de uso).
- **Segurança de Acesso (Proxmox Guard):** Login obrigatório com hash `PBKDF2-HMAC-SHA256`, cookie `HttpOnly` assinado (`HMAC-SHA256`), bloqueio anti-Brute-Force por IP e restrição de rotinas críticas ao perfil `admin`.

---

## Como Fazer o Deploy em Docker no Linux (Recomendado)

### Opção 1: Deploy Automatizado em 1 Comando
```bash
git clone git@github.com:rgerios/firebird-mnt.git
cd firebird-mnt
chmod +x deploy/docker-deploy.sh
./deploy/docker-deploy.sh
```
O script:
1. Gera o arquivo `.env` com uma `INFRAMGNT_SECRET_KEY` exclusiva.
2. Constrói e sobe o container `inframgnt-server` (com `openssh-client`, `rsync`, `zstd`, `firebird3.0-utils` e timezone `America/Sao_Paulo`).
3. Gera automaticamente o par de chaves SSH persistente do container (`backend/data/ssh/id_rsa`) e exibe a chave pública no terminal para você adicionar no `~/.ssh/authorized_keys` dos servidores Firebird.

### Opção 2: Manual via Docker Compose
```bash
cp .env.example .env
docker compose up -d --build
```

---

## Acesso Inicial

- **Painel Web:** `http://<IP_DO_SERVIDOR>:8000/login`
- **Healthcheck:** `http://<IP_DO_SERVIDOR>:8000/api/health`
- **Documentação Swagger da API:** `http://<IP_DO_SERVIDOR>:8000/docs`
- **Usuário Padrão:** `admin`
- **Senha Inicial:** `Venosan@2026` *(altere após o primeiro login clicando no botão **admin** no topo do painel)*

---

## Documentação Adicional
- [INFRAMGNT_ARQUITETURA.md](file:///Users/rgerios/Documents/VenosanBancobkp/INFRAMGNT_ARQUITETURA.md) — Arquitetura, fluxo de dados, stack e estrutura de diretórios.
- [ROTINAS_MANUTENCAO.md](file:///Users/rgerios/Documents/VenosanBancobkp/ROTINAS_MANUTENCAO.md) — Guia técnico de manutenção preventiva Firebird e tuning de kernel/disco Linux.
