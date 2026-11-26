# InfraMGNT - Guia de Rotinas de Manutenção Firebird, Otimização Linux e Laboratório Offline

Este documento detalha os procedimentos operacionais de manutenção preventiva de bancos **Firebird**, ajustes finos (tuning) do sistema operacional **Linux**, uso do **Laboratório de Análise Offline** e **Travas de Proteção de Produção** embarcados no **InfraMGNT** (`firebird-mnt`).

---

## 1. Rotinas de Manutenção do Banco de Dados Firebird

### 1.1. Recálculo de Estatísticas de Índices (`job_reindex_stats`)
* **Objetivo:** Atualizar a seletividade dos índices (`RDB$STATISTICS`) para que o otimizador de consultas do Firebird escolha os melhores planos de execução, sem precisar reconstruir os índices ou desconectar usuários (100% online).
* **Execução via `isql`:**
```sql
EXECUTE BLOCK AS
DECLARE VARIABLE idx_name VARCHAR(63);
BEGIN
  FOR SELECT TRIM(RDB$INDEX_NAME)
        FROM RDB$INDICES
       WHERE (RDB$SYSTEM_FLAG = 0 OR RDB$SYSTEM_FLAG IS NULL)
         AND (RDB$INDEX_INACTIVE = 0 OR RDB$INDEX_INACTIVE IS NULL)
        INTO :idx_name
  DO
  BEGIN
    EXECUTE STATEMENT 'SET STATISTICS INDEX ' || :idx_name || ';';
  END
END^
COMMIT^
```

### 1.2. Diagnóstico de OAT/OIT e Saúde do Cabeçalho (`job_check_health`)
* **Objetivo:** Monitorar os contadores de transação no Header Page (`Oldest Transaction` - OIT, `Oldest Active` - OAT, `Oldest Snapshot` - OST e `Next Transaction`). Um *gap* elevado (`Next - OAT`) indica transações presas impedindo a reciclagem de versões antigas de registros.
* **Impacto:** **ZERO** (100% *read-only*, lê apenas os primeiros 16 KB do cabeçalho do arquivo `.fdb`).
* **Comando:**
```bash
gstat -h -user SYSDBA -password "<SENHA>" /dados/banco.fdb
```

### 1.3. Limpeza de Lixo / Sweep Manual (`job_clean_sweep`)
* **Objetivo:** Forçar a varredura de versões obsoletas de registros (*backversions*) e avançar o contador OIT em horários fora de pico, reduzindo o inchaço da base.
* **Comando:**
```bash
gfix -sweep -user SYSDBA -password "<SENHA>" /dados/banco.fdb
```

### 1.4. Ciclo Backup + Restore Completo / Rebuild (`job_full_rebuild`)
* **Objetivo:** Reorganizar fisicamente todas as páginas de dados e reconstruir árvores B-Tree de índices do zero em janela de manutenção programada.
* **Sequência Segura:**
  1. Colocar o banco em modo *shutdown* para novas conexões:
     ```bash
     gfix -shut full -force 30 -user SYSDBA -password "<SENHA>" /dados/banco.fdb
     ```
  2. Executar o backup completo (`gbak -b -v`) e restaurar em nova base (`gbak -c -v`), seguido de validação (`gfix -v -full -n`).
  3. Alternar o arquivo validado e retornar a base para o estado online:
     ```bash
     gfix -online -user SYSDBA -password "<SENHA>" /dados/banco.fdb
     ```

---

## 2. Manutenção e Otimização do Sistema Operacional Linux

### 2.1. Ajuste de I/O de Disco (`noatime` no Filesystem)
* **Objetivo:** Evitar que o Linux grave metadados de hora do último acesso a cada leitura de página no arquivo `.fdb`.
* **Configuração:** No `/etc/fstab`, adicionar as flags na partição do banco:
```text
UUID=... /dados ext4 defaults,noatime,nodiratime 0 2
```

### 2.2. Ajuste de Gerenciamento de Memória (Swappiness)
* **Objetivo:** Priorizar o cache de dados em RAM em vez de jogar páginas para a área de swap em disco.
* **Configuração:** No `/etc/sysctl.conf`:
```text
vm.swappiness = 10
```
Aplicar imediatamente com: `sysctl -p`.

### 2.3. Manutenção de SSD/NVMe (Trim)
* **Objetivo:** Manter a taxa de transferência e vida útil de discos SSD onde o banco reside.
* **Ação:** Garantir que o timer do systemd está ativo:
```bash
systemctl enable --now fstrim.timer
```

### 2.4. Atualizações de Segurança e Pacotes
* **Objetivo:** Aplicar patches de segurança do Linux mantendo a estabilidade do Firebird.
* **Regra Importante:** Travar o pacote do Firebird para evitar upgrades acidentais de versão do banco durante um `apt upgrade` geral:
```bash
# Debian / Ubuntu:
apt-mark hold firebird*
# RHEL / Rocky / AlmaLinux:
# Adicionar no /etc/dnf/dnf.conf: exclude=firebird*
```

---

## 3. Catálogo de Jobs de Manutenção no InfraMGNT

| ID do Job | Nome na UI | Nível de Risco | Exige Parada? |
| :--- | :--- | :--- | :--- |
| `job_reindex_stats` | Recalcular Estatísticas de Índices | Mínimo | Não (100% Online) |
| `job_check_health` | Diagnóstico de OAT e Saúde do Banco | Leitura apenas | Não |
| `job_clean_sweep` | Executar Sweep Manual | Médio (I/O) | Não (Recomendado fora do pico) |
| `job_full_rebuild` | Ciclo Backup + Restore Completo | Alto | Sim (Janela de Manutenção) |
| `job_linux_patches` | Checagem de Patches & Tuning do SO | Leitura / Update | Não (Reboot opcional) |

---

## 4. Laboratório de Análise & Otimização Offline (`.fdb` Sandbox)

Para diagnósticos pesados que varrem 100% das páginas de dados e árvores de índices (`gstat -r -i`), o InfraMGNT conta com a seção **4. Laboratório de Análise & Otimização Offline**:

1. **Importação via Upload Stream ou Caminho Local:** Envie um arquivo `.fdb` da sua estação de trabalho para `/app/backend/data/offline_lab/` ou aponte para uma cópia no Servidor de Testes.
2. **Raio-X Completo (`POST /api/offline/analyze`):**
   - `gstat -h`: Verifica `ODS`, `Page Size` (alerta se `< 16384`), `OIT`, `OAT` e `Next Transaction`.
   - `gstat -r`: Lista as tabelas com maior acúmulo de lixo (*backversions*) e fragmentação (*Average Fill %*).
   - `gstat -i`: Identifica índices com profundidade elevada (`Depth >= 3`), indicando necessidade de recálculo de seletividade ou Rebuild 16KB.
   - `gfix -v -full -n`: Audita páginas corrompidas ou órfãs.
3. **Otimização Offline em 1 Clique (`POST /api/offline/optimize`):**
   - Aplica `gfix -sweep`, `SET STATISTICS INDEX`, `gfix -mend -full -ignore` ou **Rebuild Completo para Page Size 16384** diretamente no arquivo isolado.

---

## 5. Travas Hard de Proteção de Produção

1. **Bloqueio de Restore em Produção:** O endpoint `/api/jobs/restore-validate` e o `/api/jobs/full-pipeline` bloqueiam com `HTTP 403` qualquer tentativa de executar `gbak -c -rep` em um servidor cadastrado com papel `Produção` ou no caminho do `.fdb` principal.
2. **Checagem Pré-Backup de Disco (`df -P`):** Antes de iniciar o `gbak -b`, o sistema verifica se a partição de destino tem menos de 90% de ocupação, abortando preventivamente caso o disco esteja cheio.
3. **Segurança de Perfil (`admin` vs `operator`):** Operadores não-administradores são impedidos de disparar rotinas que exigem parada (`job_full_rebuild`) ou alteração de kernel Linux (`apply_optimizations`).
