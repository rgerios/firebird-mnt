import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.core.database import LOGS_DIR, dict_from_row, ensure_dirs, get_db, now_iso
from app.models.schemas import (
    BackupJobRequest,
    FullPipelineJobRequest,
    MaintenanceJobRequest,
    RestoreValidateJobRequest,
    TransferJobRequest,
)
from app.services.ssh_service import (
    STAGING_DIR,
    mask_sensitive,
    offload_backup_stream_to_local,
    relay_transfer_between_hosts,
    run_ssh_command_stream,
    upload_local_file_to_host,
)
from app.services.ws_manager import ws_manager

MAINTENANCE_CATALOG: Dict[str, Dict[str, Any]] = {
    "job_reindex_stats": {
        "id": "job_reindex_stats",
        "title": "Recalcular Estatísticas de Índices",
        "risk": "Mínimo",
        "risk_level": "low",
        "downtime": "Não (100% Online)",
        "requires_downtime": False,
        "description": "Atualiza a seletividade (SET STATISTICS INDEX) de todos os índices de usuário via isql para otimizar planos de consulta sem bloquear tabelas.",
    },
    "job_check_health": {
        "id": "job_check_health",
        "title": "Diagnóstico de OAT e Saúde do Banco",
        "risk": "Leitura apenas",
        "risk_level": "readonly",
        "downtime": "Não",
        "requires_downtime": False,
        "description": "Executa gstat -h e inspeciona OIT, OAT, OST, Next Transaction e gap de transações presas que impedem o garbage collection.",
    },
    "job_clean_sweep": {
        "id": "job_clean_sweep",
        "title": "Executar Sweep Manual (gfix -sweep)",
        "risk": "Médio (I/O)",
        "risk_level": "medium",
        "downtime": "Não (Recomendado fora do pico)",
        "requires_downtime": False,
        "description": "Dispara gfix -sweep para limpar versões antigas de registros (backversions) e avançar o contador Oldest Transaction (OIT).",
    },
    "job_full_rebuild": {
        "id": "job_full_rebuild",
        "title": "Ciclo Backup + Restore Completo (Rebuild)",
        "risk": "Alto",
        "risk_level": "high",
        "downtime": "Sim (Janela de Manutenção)",
        "requires_downtime": True,
        "description": "Executa gfix -shut full -> gbak -b -> gbak -c -> gfix -v -full -n -> substituição segura do .fdb -> gfix -online.",
    },
    "job_linux_patches": {
        "id": "job_linux_patches",
        "title": "Checagem de Patches & Tuning do SO Linux",
        "risk": "Leitura / Update",
        "risk_level": "low",
        "downtime": "Não (Reboot opcional)",
        "requires_downtime": False,
        "description": "Verifica e aplica noatime/nodiratime no fstab, vm.swappiness=10 (sysctl), fstrim.timer (SSD/NVMe), apt-mark hold firebird* e patches de segurança.",
    },
}


def get_host_by_id(host_id: int) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM hosts WHERE id = ?", (host_id,))
        return dict_from_row(cur.fetchone())


def create_execution_record(
    job_type: str,
    job_title: str,
    source_host: Optional[Dict[str, Any]],
    target_host: Optional[Dict[str, Any]],
    params: Dict[str, Any],
    command_preview: str,
) -> int:
    ensure_dirs()
    started = now_iso()
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO executions (
                job_type, job_title, source_host_id, target_host_id,
                source_host_name, target_host_name, parameters_json,
                command_preview, status, started_at, summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
            """,
            (
                job_type,
                job_title,
                source_host["id"] if source_host else None,
                target_host["id"] if target_host else None,
                source_host["name"] if source_host else None,
                target_host["name"] if target_host else None,
                json.dumps(params, ensure_ascii=False),
                mask_sensitive(command_preview),
                started,
                "Em execução...",
            ),
        )
        exec_id = int(cur.lastrowid)
        log_path = LOGS_DIR / f"execution_{exec_id}.log"
        cur.execute(
            "UPDATE executions SET log_file_path = ? WHERE id = ?",
            (str(log_path), exec_id),
        )
    return exec_id


def finalize_execution_record(
    exec_id: int,
    status: str,
    duration_seconds: float,
    summary: str,
    artifact_file: str = "",
) -> None:
    finished = now_iso()
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE executions
               SET status = ?,
                   finished_at = ?,
                   duration_seconds = ?,
                   summary = ?,
                   artifact_file = ?
             WHERE id = ?
            """,
            (status, finished, round(duration_seconds, 2), summary, artifact_file, exec_id),
        )


class ExecutionLogger:
    def __init__(self, exec_id: int):
        self.exec_id = exec_id
        ensure_dirs()
        self.log_path = LOGS_DIR / f"execution_{exec_id}.log"
        with open(self.log_path, "w", encoding="utf-8") as f:
            f.write(f"=== InfraMGNT Execution Log #{exec_id} ===\n")
            f.write(f"Started At: {now_iso()}\n")
            f.write("=" * 60 + "\n")

    async def log(
        self,
        line: str,
        level: str = "info",
        host_name: str = "InfraMGNT",
        step: str = "",
    ) -> None:
        safe_line = mask_sensitive(line)
        ts = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        prefix = f"[{ts}] [{host_name}]"
        if step:
            prefix += f" [{step}]"
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(f"{prefix} ({level.upper()}) {safe_line}\n")

        await ws_manager.emit_log(
            execution_id=self.exec_id,
            line=safe_line,
            level=level,
            host_name=host_name,
            step=step,
        )


# ---------------------------------------------------------------------------
# Command Builders (Backup, Restore, gfix & Maintenance Routines)
# ---------------------------------------------------------------------------

def build_backup_command(
    host: Dict[str, Any],
    db_path: str,
    backup_dir: str,
    compression: str,
    no_gc: bool,
    verbose: bool,
    timestamp_tag: str,
) -> Tuple[str, str]:
    fb_user = host.get("fb_user") or "SYSDBA"
    fb_pass = host.get("fb_password") or "masterkey"
    flags = ["-b"]
    if no_gc:
        flags.append("-g")
    if verbose:
        flags.append("-v")
    flag_str = " ".join(flags)

    db_stem = Path(db_path).stem or "base"
    clean_dir = backup_dir.rstrip("/")

    if compression == "zstd":
        out_file = f"{clean_dir}/{db_stem}_{timestamp_tag}.fbk.zst"
        cmd = (
            f"mkdir -p '{clean_dir}' && set -o pipefail && "
            f"gbak {flag_str} -user {fb_user} -password \"{fb_pass}\" '{db_path}' stdout "
            f"| zstd -1 -T0 > '{out_file}'"
        )
    elif compression == "gzip":
        out_file = f"{clean_dir}/{db_stem}_{timestamp_tag}.fbk.gz"
        cmd = (
            f"mkdir -p '{clean_dir}' && set -o pipefail && "
            f"gbak {flag_str} -user {fb_user} -password \"{fb_pass}\" '{db_path}' stdout "
            f"| gzip -1 > '{out_file}'"
        )
    else:
        out_file = f"{clean_dir}/{db_stem}_{timestamp_tag}.fbk"
        cmd = (
            f"mkdir -p '{clean_dir}' && "
            f"gbak {flag_str} -user {fb_user} -password \"{fb_pass}\" '{db_path}' '{out_file}'"
        )

    return cmd, out_file


def build_restore_command(
    host: Dict[str, Any],
    backup_file: str,
    restore_db_path: str,
    compression: str,
    replace_existing: bool,
) -> str:
    fb_user = host.get("fb_user") or "SYSDBA"
    fb_pass = host.get("fb_password") or "masterkey"
    restore_dir = str(Path(restore_db_path).parent)
    mode_flag = "-c -rep" if replace_existing else "-c"

    comp = compression
    if comp == "auto":
        if backup_file.endswith(".zst"):
            comp = "zstd"
        elif backup_file.endswith(".gz"):
            comp = "gzip"
        else:
            comp = "none"

    if comp == "zstd":
        return (
            f"mkdir -p '{restore_dir}' && set -o pipefail && "
            f"zstd -dc '{backup_file}' | "
            f"gbak {mode_flag} -v -user {fb_user} -password \"{fb_pass}\" stdin '{restore_db_path}'"
        )
    elif comp == "gzip":
        return (
            f"mkdir -p '{restore_dir}' && set -o pipefail && "
            f"gzip -dc '{backup_file}' | "
            f"gbak {mode_flag} -v -user {fb_user} -password \"{fb_pass}\" stdin '{restore_db_path}'"
        )
    else:
        return (
            f"mkdir -p '{restore_dir}' && "
            f"gbak {mode_flag} -v -user {fb_user} -password \"{fb_pass}\" '{backup_file}' '{restore_db_path}'"
        )


def build_gfix_command(host: Dict[str, Any], restore_db_path: str) -> str:
    fb_user = host.get("fb_user") or "SYSDBA"
    fb_pass = host.get("fb_password") or "masterkey"
    return f"gfix -v -full -n -user {fb_user} -password \"{fb_pass}\" '{restore_db_path}'"


def build_maintenance_command_preview(
    host: Dict[str, Any], req: MaintenanceJobRequest
) -> str:
    fb_user = host.get("fb_user") or "SYSDBA"
    fb_pass = host.get("fb_password") or "masterkey"
    db_path = req.db_path or host.get("default_db_path") or "/dados/banco.fdb"
    bkp_dir = (req.backup_dir or host.get("default_backup_dir") or "/backups").rstrip("/")

    if req.job_id == "job_reindex_stats":
        return (
            f"isql -user {fb_user} -password \"{fb_pass}\" '{db_path}' << 'EOF'\n"
            f"SET TERM ^ ;\n"
            f"EXECUTE BLOCK AS DECLARE VARIABLE idx VARCHAR(63); BEGIN\n"
            f"  FOR SELECT TRIM(RDB$INDEX_NAME) FROM RDB$INDICES\n"
            f"      WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0 AND COALESCE(RDB$INDEX_INACTIVE,0)=0 INTO :idx DO\n"
            f"    EXECUTE STATEMENT 'SET STATISTICS INDEX ' || :idx || ';';\n"
            f"END^\n"
            f"COMMIT^\n"
            f"EOF"
        )
    elif req.job_id == "job_check_health":
        return f"gstat -h -user {fb_user} -password \"{fb_pass}\" '{db_path}'"
    elif req.job_id == "job_clean_sweep":
        return f"gfix -sweep -user {fb_user} -password \"{fb_pass}\" '{db_path}'"
    elif req.job_id == "job_full_rebuild":
        timeout = req.force_shutdown_timeout
        return (
            f"gfix -shut full -force {timeout} -user {fb_user} -password \"{fb_pass}\" '{db_path}' && "
            f"gbak -b -v -user {fb_user} -password \"{fb_pass}\" '{db_path}' '{bkp_dir}/rebuild.fbk' && "
            f"gbak -c -v -user {fb_user} -password \"{fb_pass}\" '{bkp_dir}/rebuild.fbk' '{db_path}.new' && "
            f"gfix -v -full -n -user {fb_user} -password \"{fb_pass}\" '{db_path}.new' && "
            f"mv '{db_path}' '{db_path}.old' && mv '{db_path}.new' '{db_path}' && "
            f"gfix -online -user {fb_user} -password \"{fb_pass}\" '{db_path}'"
        )
    else:  # job_linux_patches
        if req.linux_action_mode == "apply_optimizations":
            return (
                "grep -E 'noatime' /etc/fstab; "
                "sysctl -w vm.swappiness=10 && sed -i '/vm.swappiness/d' /etc/sysctl.conf && echo 'vm.swappiness = 10' >> /etc/sysctl.conf; "
                "systemctl enable --now fstrim.timer; "
                "(command -v apt-mark >/dev/null && apt-mark hold 'firebird*' && apt-get -s upgrade) || "
                "(grep -q 'exclude=firebird' /etc/dnf/dnf.conf || echo 'exclude=firebird*' >> /etc/dnf/dnf.conf && dnf check-update --security)"
            )
        return (
            "findmnt -no TARGET,OPTIONS /dados || grep -v '^#' /etc/fstab; "
            "sysctl vm.swappiness; "
            "systemctl is-enabled fstrim.timer && systemctl is-active fstrim.timer; "
            "(command -v apt-mark >/dev/null && apt-mark showhold | grep firebird && apt-get -s upgrade | grep -i security) || "
            "(grep firebird /etc/dnf/dnf.conf; dnf check-update --security)"
        )


# ---------------------------------------------------------------------------
# Simulated Firebird Output Generators
# ---------------------------------------------------------------------------

async def _simulate_gbak_backup(
    logger: ExecutionLogger,
    host_name: str,
    db_path: str,
    out_file: str,
    no_gc: bool,
    compression: str,
) -> None:
    steps = [
        ("gbak:lendo metadados da base " + db_path, "info", 0.16),
        (
            "gbak:modo -g ativo (Garbage Collection suprimido para zero impacto em produção)"
            if no_gc
            else "gbak:Garbage Collection padrão habilitado",
            "info",
            0.14,
        ),
        ("gbak:escrevendo domínios, generators (sequences) e exceptions", "info", 0.14),
        ("gbak:escrevendo tabela CLIENTES (148.920 registros)", "info", 0.18),
        ("gbak:escrevendo tabela PRODUTOS_VENOSAN (12.450 registros)", "info", 0.16),
        ("gbak:escrevendo tabela PEDIDOS_VENDA (892.310 registros)", "info", 0.22),
        ("gbak:escrevendo tabela ITENS_PEDIDO (3.412.880 registros)", "info", 0.28),
        ("gbak:escrevendo tabela MOVIMENTO_ESTOQUE (4.129.005 registros)", "info", 0.28),
        ("gbak:escrevendo tabela NOTAS_FISCAIS_NFE (610.204 registros)", "info", 0.20),
        ("gbak:escrevendo tabela TITULOS_FINANCEIRO (925.110 registros)", "info", 0.18),
        ("gbak:escrevendo stored procedures, triggers e views corporativas", "info", 0.16),
        ("gbak:escrevendo definições de índices e constraints (FK/PK)", "info", 0.15),
        (
            f"stream:compressão em pipe ({compression.upper()}) finalizada -> {out_file} (1.42 GB comprimido, ratio 4.8x)",
            "success",
            0.15,
        ),
        ("gbak:closing, and going home", "success", 0.10),
    ]
    for msg, lvl, delay in steps:
        await logger.log(msg, level=lvl, host_name=host_name, step="BACKUP")
        await asyncio.sleep(delay)


async def _simulate_transfer(
    logger: ExecutionLogger,
    src_host: Dict[str, Any],
    dst_host: Dict[str, Any],
    source_file: str,
    target_dir: str,
    method: str,
) -> str:
    filename = os.path.basename(source_file.rstrip("/"))
    dst_path = f"{target_dir.rstrip('/')}/{filename}"
    host_tag = f"{src_host['name']} -> {dst_host['name']}"

    steps = [
        (f"Iniciando transferência via {method.upper()} de {source_file} para {dst_host['hostname']}:{dst_path}", "info", 0.18),
        (f"{filename}:  24%  348.90MB  89.4MB/s   00:11 ETA", "info", 0.20),
        (f"{filename}:  61%  886.98MB  93.1MB/s   00:05 ETA", "info", 0.20),
        (f"{filename}: 100% 1454.08MB  92.8MB/s   00:00 (Transferência concluída)", "success", 0.18),
        (f"SHA-256 Checksum verificado com sucesso em {dst_host['hostname']}:{dst_path}", "success", 0.12),
    ]
    for msg, lvl, delay in steps:
        await logger.log(msg, level=lvl, host_name=host_tag, step="TRANSFER")
        await asyncio.sleep(delay)
    return dst_path


async def _simulate_restore_and_gfix(
    logger: ExecutionLogger,
    host_name: str,
    backup_file: str,
    restore_db_path: str,
    run_gfix: bool,
    simulate_corruption: bool = False,
) -> Tuple[str, str]:
    restore_steps = [
        (f"stream:descomprimindo {backup_file} em pipe para stdin do gbak...", "info", 0.18),
        (f"gbak:opened file stdin -> recriando base {restore_db_path} (page size 16384)", "info", 0.18),
        ("gbak:restaurando domínios, generators e tabelas do sistema", "info", 0.16),
        ("gbak:restaurando dados da tabela CLIENTES (148.920 registros)", "info", 0.18),
        ("gbak:restaurando dados da tabela PRODUTOS_VENOSAN (12.450 registros)", "info", 0.16),
        ("gbak:restaurando dados da tabela PEDIDOS_VENDA (892.310 registros)", "info", 0.20),
        ("gbak:restaurando dados da tabela ITENS_PEDIDO (3.412.880 registros)", "info", 0.24),
        ("gbak:restaurando dados da tabela MOVIMENTO_ESTOQUE (4.129.005 registros)", "info", 0.24),
        ("gbak:ativando e reconstruindo B-Tree indexes (PK_CLIENTES, IDX_PEDIDOS_DATA, FK_ITENS_PEDIDO...)", "info", 0.24),
        ("gbak:committing metadata e finalizando transação de restore", "info", 0.15),
        ("gbak:finishing, closing, and going home", "success", 0.12),
    ]
    for msg, lvl, delay in restore_steps:
        await logger.log(msg, level=lvl, host_name=host_name, step="RESTORE")
        await asyncio.sleep(delay)

    if not run_gfix:
        return "success", f"Restore concluído com sucesso em {restore_db_path} (validação gfix desativada)."

    await logger.log(
        f"Iniciando validação física de páginas e estruturas lógicas (gfix -v -full -n) em {restore_db_path}...",
        level="info",
        host_name=host_name,
        step="GFIX",
    )
    await asyncio.sleep(0.20)

    if simulate_corruption:
        gfix_steps = [
            ("gfix: verificando alocação de Pointer Pages e Data Pages...", "info", 0.20),
            ("Summary of validation errors:", "warn", 0.18),
            ("    Number of record level errors : 2", "error", 0.15),
            ("    Number of index page errors   : 1", "warn", 0.15),
            ("    Number of database page errors: 0", "info", 0.15),
        ]
        for msg, lvl, delay in gfix_steps:
            await logger.log(msg, level=lvl, host_name=host_name, step="GFIX")
            await asyncio.sleep(delay)
        return (
            "warning",
            "Restore concluído, porém o gfix detectou 2 erros de registro e 1 erro de página de índice.",
        )

    gfix_ok_steps = [
        ("gfix: validando Pointer Pages (PP), Transaction Inventory Pages (TIP) e Index Root Pages...", "info", 0.20),
        ("gfix: validando integridade de fragmentos de registros e cadeias de backversions...", "info", 0.20),
        ("gfix: 0 erros de página, 0 páginas órfãs, 0 corrupções de índice detectadas.", "success", 0.15),
        (f"Validação física (gfix -v -full -n) aprovada 100% na base {restore_db_path}!", "success", 0.12),
    ]
    for msg, lvl, delay in gfix_ok_steps:
        await logger.log(msg, level=lvl, host_name=host_name, step="GFIX")
        await asyncio.sleep(delay)

    return "success", f"Base restaurada e validada com 0 erros de integridade em {restore_db_path}."


# ---------------------------------------------------------------------------
# Public Async Job Runners (Backup, Transfer, Restore & Full Pipeline)
# ---------------------------------------------------------------------------

async def execute_backup_job(exec_id: int, req: BackupJobRequest) -> None:
    t0 = time.perf_counter()
    logger = ExecutionLogger(exec_id)
    host = get_host_by_id(req.host_id)
    if not host:
        await logger.log(f"Host ID {req.host_id} não encontrado.", level="error")
        finalize_execution_record(exec_id, "error", 0.1, "Servidor não encontrado.")
        await ws_manager.emit_status(exec_id, "error", "Job 1: Backup Produção", "Servidor não encontrado.")
        return

    ts_tag = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d_%H%M%S")
    cmd, out_file = build_backup_command(
        host=host,
        db_path=req.db_path,
        backup_dir=req.backup_dir,
        compression=req.compression,
        no_gc=req.no_gc,
        verbose=req.verbose,
        timestamp_tag=ts_tag,
    )

    is_offload = req.compression_location != "source"
    if is_offload:
        out_file = str(STAGING_DIR / os.path.basename(out_file))

    host_label = host["name"]
    loc_label = f" [Offload: {req.compression_location}]" if is_offload else ""
    await logger.log(
        f"Iniciando Job 1 (Backup Quente Firebird{loc_label}) em {host_label} ({host['hostname']})...",
        level="info",
        host_name=host_label,
        step="BACKUP",
    )
    if is_offload:
        await logger.log(
            f"[Offload App] gbak -b {'-g ' if req.no_gc else ''}stdout ({host['hostname']}) -> compressão {req.compression} na máquina da aplicação -> {out_file}",
            level="cmd",
            host_name="InfraMGNT",
            step="BACKUP",
        )
    else:
        await logger.log(f"$ {mask_sensitive(cmd)}", level="cmd", host_name=host_label, step="BACKUP")

    try:
        if host.get("is_simulated"):
            await _simulate_gbak_backup(
                logger=logger,
                host_name=host_label,
                db_path=req.db_path,
                out_file=out_file,
                no_gc=req.no_gc,
                compression=req.compression,
            )
            status = "success"
            summary = f"Backup gerado com sucesso: {out_file}"
        elif is_offload:
            async def _on_offload(line: str, lvl: str) -> None:
                await logger.log(line, level=lvl, host_name="InfraMGNT", step="BACKUP")

            exit_code, out_file = await offload_backup_stream_to_local(
                source_host=host,
                db_path=req.db_path,
                local_out_file=out_file,
                compression=req.compression,
                mode=req.compression_location,
                no_gc=req.no_gc,
                verbose=req.verbose,
                on_line=_on_offload,
            )
            if exit_code == 0:
                status = "success"
                summary = f"Backup offload concluído na máquina da aplicação: {out_file}"
                await logger.log(summary, level="success", host_name="InfraMGNT", step="BACKUP")
            else:
                status = "error"
                summary = f"Offload backup falhou com código {exit_code}."
                await logger.log(summary, level="error", host_name="InfraMGNT", step="BACKUP")
        else:
            # Trava Pré-Backup: Verifica espaço livre em disco na partição de destino (> 10% livre)
            df_check_cmd = (
                f"mkdir -p '{req.backup_dir}' && "
                f"USED_PCT=$(df -P '{req.backup_dir}' | tail -n 1 | awk '{{print $5}}' | tr -d '%'); "
                f"if [ \"$USED_PCT\" -ge 90 ]; then "
                f"  echo \"TRAVA DE SEGURANÇA: Disco em ${USED_PCT}% de uso em {req.backup_dir}. Backup abortado para proteger o Firebird!\"; "
                f"  exit 91; "
                f"fi"
            )
            async def _on_line(line: str, lvl: str) -> None:
                await logger.log(line, level=lvl, host_name=host_label, step="BACKUP")

            chk_code, _ = await run_ssh_command_stream(host, df_check_cmd, _on_line)
            if chk_code != 0:
                raise RuntimeError("Trava de Segurança acionada: Espaço em disco insuficiente (>= 90% ocupado).")

            exit_code, _ = await run_ssh_command_stream(host, cmd, _on_line)
            if exit_code == 0:
                status = "success"
                summary = f"Backup concluído com sucesso: {out_file}"
                await logger.log(summary, level="success", host_name=host_label, step="BACKUP")
            else:
                status = "error"
                summary = f"gbak retornou código de saída {exit_code}."
                await logger.log(summary, level="error", host_name=host_label, step="BACKUP")
    except Exception as exc:
        status = "error"
        summary = f"Erro durante o backup SSH: {exc}"
        await logger.log(summary, level="error", host_name=host_label, step="BACKUP")

    duration = time.perf_counter() - t0
    finalize_execution_record(exec_id, status, duration, summary, artifact_file=out_file if status == "success" else "")
    await ws_manager.emit_status(exec_id, status, "Job 1: Backup Produção (gbak -b)", summary, duration)


async def execute_transfer_job(exec_id: int, req: TransferJobRequest) -> None:
    t0 = time.perf_counter()
    logger = ExecutionLogger(exec_id)
    src_host = get_host_by_id(req.source_host_id)
    dst_host = get_host_by_id(req.target_host_id)
    if not src_host or not dst_host:
        msg = "Servidor de origem ou destino não encontrado."
        await logger.log(msg, level="error")
        finalize_execution_record(exec_id, "error", 0.1, msg)
        await ws_manager.emit_status(exec_id, "error", "Job 2: Transferência SCP/Rsync", msg)
        return

    host_tag = f"{src_host['name']} -> {dst_host['name']}"
    dst_path = ""
    try:
        if src_host.get("is_simulated") or dst_host.get("is_simulated"):
            dst_path = await _simulate_transfer(
                logger=logger,
                src_host=src_host,
                dst_host=dst_host,
                source_file=req.source_file,
                target_dir=req.target_dir,
                method=req.method,
            )
            status = "success"
            summary = f"Arquivo transferido para {dst_host['name']}:{dst_path}"
        else:
            async def _on_line(line: str, lvl: str) -> None:
                await logger.log(line, level=lvl, host_name=host_tag, step="TRANSFER")

            exit_code, dst_path = await relay_transfer_between_hosts(
                source_host=src_host,
                target_host=dst_host,
                source_file=req.source_file,
                target_dir=req.target_dir,
                method=req.method,
                on_line=_on_line,
            )
            if exit_code == 0:
                status = "success"
                summary = f"Transferência concluída: {dst_path}"
                await logger.log(summary, level="success", host_name=host_tag, step="TRANSFER")
            else:
                status = "error"
                summary = f"Falha na transferência (exit code {exit_code})."
                await logger.log(summary, level="error", host_name=host_tag, step="TRANSFER")
    except Exception as exc:
        status = "error"
        summary = f"Erro durante transferência: {exc}"
        await logger.log(summary, level="error", host_name=host_tag, step="TRANSFER")

    duration = time.perf_counter() - t0
    finalize_execution_record(exec_id, status, duration, summary, artifact_file=dst_path if status == "success" else "")
    await ws_manager.emit_status(exec_id, status, "Job 2: Envio para Servidor de Testes", summary, duration)


async def execute_restore_validate_job(exec_id: int, req: RestoreValidateJobRequest) -> None:
    t0 = time.perf_counter()
    logger = ExecutionLogger(exec_id)
    host = get_host_by_id(req.host_id)
    if not host:
        msg = f"Host ID {req.host_id} não encontrado."
        await logger.log(msg, level="error")
        finalize_execution_record(exec_id, "error", 0.1, msg)
        await ws_manager.emit_status(exec_id, "error", "Job 3: Restore & Validação", msg)
        return

    host_label = host["name"]
    restore_cmd = build_restore_command(
        host=host,
        backup_file=req.backup_file,
        restore_db_path=req.restore_db_path,
        compression=req.compression,
        replace_existing=req.replace_existing,
    )
    gfix_cmd = build_gfix_command(host=host, restore_db_path=req.restore_db_path)

    await logger.log(
        f"Iniciando Job 3 (Restore + Validação Física) em {host_label} ({host['hostname']})...",
        level="info",
        host_name=host_label,
        step="RESTORE",
    )
    await logger.log(f"$ {mask_sensitive(restore_cmd)}", level="cmd", host_name=host_label, step="RESTORE")
    if req.run_gfix:
        await logger.log(f"$ {mask_sensitive(gfix_cmd)}", level="cmd", host_name=host_label, step="GFIX")

    try:
        if host.get("is_simulated"):
            status, summary = await _simulate_restore_and_gfix(
                logger=logger,
                host_name=host_label,
                backup_file=req.backup_file,
                restore_db_path=req.restore_db_path,
                run_gfix=req.run_gfix,
                simulate_corruption=req.simulate_corruption,
            )
        else:
            async def _on_restore_line(line: str, lvl: str) -> None:
                await logger.log(line, level=lvl, host_name=host_label, step="RESTORE")

            r_code, _ = await run_ssh_command_stream(host, restore_cmd, _on_restore_line)
            if r_code != 0:
                status = "error"
                summary = f"Falha no gbak restore (código {r_code})."
                await logger.log(summary, level="error", host_name=host_label, step="RESTORE")
            elif req.run_gfix:
                async def _on_gfix_line(line: str, lvl: str) -> None:
                    await logger.log(line, level=lvl, host_name=host_label, step="GFIX")

                g_code, g_out = await run_ssh_command_stream(host, gfix_cmd, _on_gfix_line)
                if g_code != 0 or "errors" in g_out.lower():
                    status = "warning"
                    summary = "Restore concluído, mas gfix reportou anomalias físicas na base."
                    await logger.log(summary, level="warn", host_name=host_label, step="GFIX")
                else:
                    status = "success"
                    summary = f"Restore e validação gfix concluídos com 0 erros em {req.restore_db_path}."
                    await logger.log(summary, level="success", host_name=host_label, step="GFIX")
            else:
                status = "success"
                summary = f"Restore concluído com sucesso em {req.restore_db_path}."
    except Exception as exc:
        status = "error"
        summary = f"Exceção durante Restore/Validação: {exc}"
        await logger.log(summary, level="error", host_name=host_label, step="RESTORE")

    duration = time.perf_counter() - t0
    finalize_execution_record(exec_id, status, duration, summary, artifact_file=req.restore_db_path)
    await ws_manager.emit_status(exec_id, status, "Job 3: Restore & Validação (gbak -c + gfix)", summary, duration)


async def execute_full_pipeline_job(exec_id: int, req: FullPipelineJobRequest) -> None:
    t0 = time.perf_counter()
    logger = ExecutionLogger(exec_id)
    prod_host = get_host_by_id(req.prod_host_id)
    test_host = get_host_by_id(req.test_host_id)

    if not prod_host or not test_host:
        msg = "Servidor de produção ou servidor de testes não encontrado."
        await logger.log(msg, level="error")
        finalize_execution_record(exec_id, "error", 0.1, msg)
        await ws_manager.emit_status(exec_id, "error", "Job 4: Pipeline Completo (1-Clique)", msg)
        return

    ts_tag = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d_%H%M%S")
    backup_cmd, prod_backup_file = build_backup_command(
        host=prod_host,
        db_path=req.prod_db_path,
        backup_dir=req.prod_backup_dir,
        compression=req.compression,
        no_gc=req.no_gc,
        verbose=True,
        timestamp_tag=ts_tag,
    )

    filename = os.path.basename(prod_backup_file)
    test_backup_file = f"{req.test_backup_dir.rstrip('/')}/{filename}"
    restore_cmd = build_restore_command(
        host=test_host,
        backup_file=test_backup_file,
        restore_db_path=req.test_restore_db_path,
        compression=req.compression,
        replace_existing=True,
    )
    gfix_cmd = build_gfix_command(host=test_host, restore_db_path=req.test_restore_db_path)

    await logger.log(
        "======================================================================",
        level="info",
        host_name="Pipeline",
        step="INIT",
    )
    await logger.log(
        f"INICIANDO PIPELINE COMPLETO DE BACKUP & VALIDAÇÃO FIREBIRD (#{exec_id})",
        level="info",
        host_name="Pipeline",
        step="INIT",
    )
    await logger.log(
        f"Origem (Produção): {prod_host['name']} ({prod_host['hostname']}) -> Base: {req.prod_db_path}",
        level="info",
        host_name="Pipeline",
        step="INIT",
    )
    await logger.log(
        f"Destino (Validação): {test_host['name']} ({test_host['hostname']}) -> Base: {req.test_restore_db_path}",
        level="info",
        host_name="Pipeline",
        step="INIT",
    )
    await logger.log(
        "======================================================================",
        level="info",
        host_name="Pipeline",
        step="INIT",
    )

    is_offload = req.compression_location != "source"
    local_staging_file = str(STAGING_DIR / filename)

    try:
        if is_offload:
            await logger.log(
                f"[ETAPA 1/4] Puxando stream gbak cru de {prod_host['name']} e comprimindo na Máquina da Aplicação ({req.compression_location})...",
                level="info",
                host_name="InfraMGNT",
                step="1/4 OFFLOAD",
            )
            if prod_host.get("is_simulated"):
                await _simulate_gbak_backup(
                    logger=logger,
                    host_name="InfraMGNT (Staging)",
                    db_path=req.prod_db_path,
                    out_file=local_staging_file,
                    no_gc=req.no_gc,
                    compression=req.compression,
                )
            else:
                async def _on_offload(line: str, lvl: str) -> None:
                    await logger.log(line, level=lvl, host_name="InfraMGNT", step="1/4 OFFLOAD")

                code, local_staging_file = await offload_backup_stream_to_local(
                    source_host=prod_host,
                    db_path=req.prod_db_path,
                    local_out_file=local_staging_file,
                    compression=req.compression,
                    mode=req.compression_location,
                    no_gc=req.no_gc,
                    verbose=True,
                    on_line=_on_offload,
                )
                if code != 0:
                    raise RuntimeError(f"Etapa 1 (Offload gbak + {req.compression}) falhou com código {code}.")

            await logger.log(
                f"[ETAPA 2/4] Enviando {filename} da Máquina da Aplicação para {test_host['name']} ({req.test_backup_dir})...",
                level="info",
                host_name=f"InfraMGNT -> {test_host['name']}",
                step="2/4 UPLOAD",
            )
            if prod_host.get("is_simulated") or test_host.get("is_simulated"):
                test_backup_file = await _simulate_transfer(
                    logger=logger,
                    src_host=prod_host,
                    dst_host=test_host,
                    source_file=local_staging_file,
                    target_dir=req.test_backup_dir,
                    method=req.transfer_method,
                )
            else:
                async def _on_upload(line: str, lvl: str) -> None:
                    await logger.log(
                        line,
                        level=lvl,
                        host_name=f"InfraMGNT -> {test_host['name']}",
                        step="2/4 UPLOAD",
                    )

                code, test_backup_file = await upload_local_file_to_host(
                    local_file=local_staging_file,
                    target_host=test_host,
                    target_dir=req.test_backup_dir,
                    on_line=_on_upload,
                )
                if code != 0:
                    raise RuntimeError(f"Etapa 2 (Upload ao destino) falhou com código {code}.")
        else:
            await logger.log(
                "[ETAPA 1/4] Executando Backup Quente na Máquina de Produção...",
                level="info",
                host_name=prod_host["name"],
                step="1/4 BACKUP",
            )
            await logger.log(
                f"$ {mask_sensitive(backup_cmd)}",
                level="cmd",
                host_name=prod_host["name"],
                step="1/4 BACKUP",
            )

            if prod_host.get("is_simulated"):
                await _simulate_gbak_backup(
                    logger=logger,
                    host_name=prod_host["name"],
                    db_path=req.prod_db_path,
                    out_file=prod_backup_file,
                    no_gc=req.no_gc,
                    compression=req.compression,
                )
            else:
                async def _on_bkp(line: str, lvl: str) -> None:
                    await logger.log(line, level=lvl, host_name=prod_host["name"], step="1/4 BACKUP")

                code, _ = await run_ssh_command_stream(prod_host, backup_cmd, _on_bkp)
                if code != 0:
                    raise RuntimeError(f"Etapa 1 (gbak backup) falhou com código {code}.")

            await logger.log(
                f"[ETAPA 2/4] Transferindo {prod_backup_file} para {test_host['name']} ({req.transfer_method.upper()})...",
                level="info",
                host_name=f"{prod_host['name']} -> {test_host['name']}",
                step="2/4 TRANSFER",
            )
            if prod_host.get("is_simulated") or test_host.get("is_simulated"):
                test_backup_file = await _simulate_transfer(
                    logger=logger,
                    src_host=prod_host,
                    dst_host=test_host,
                    source_file=prod_backup_file,
                    target_dir=req.test_backup_dir,
                    method=req.transfer_method,
                )
            else:
                async def _on_xfer(line: str, lvl: str) -> None:
                    await logger.log(
                        line,
                        level=lvl,
                        host_name=f"{prod_host['name']} -> {test_host['name']}",
                        step="2/4 TRANSFER",
                    )

                code, test_backup_file = await relay_transfer_between_hosts(
                    source_host=prod_host,
                    target_host=test_host,
                    source_file=prod_backup_file,
                    target_dir=req.test_backup_dir,
                    method=req.transfer_method,
                    on_line=_on_xfer,
                )
                if code != 0:
                    raise RuntimeError(f"Etapa 2 (Transferência) falhou com código {code}.")

        if not req.run_restore:
            status = "success"
            summary = f"Backup comprimido e entregue no destino {test_host['name']}:{test_backup_file} (sem restore)."
        else:
            await logger.log(
                f"[ETAPA 3/4] Restaurando backup na máquina de validação ({test_host['name']})...",
                level="info",
                host_name=test_host["name"],
                step="3/4 RESTORE",
            )
            await logger.log(
                f"$ {mask_sensitive(restore_cmd)}",
                level="cmd",
                host_name=test_host["name"],
                step="3/4 RESTORE",
            )
            if req.run_gfix:
                await logger.log(
                    f"$ {mask_sensitive(gfix_cmd)}",
                    level="cmd",
                    host_name=test_host["name"],
                    step="4/4 GFIX",
                )

            if test_host.get("is_simulated"):
                status, step_summary = await _simulate_restore_and_gfix(
                    logger=logger,
                    host_name=test_host["name"],
                    backup_file=test_backup_file,
                    restore_db_path=req.test_restore_db_path,
                    run_gfix=req.run_gfix,
                    simulate_corruption=False,
                )
                summary = f"Pipeline 1-Clique concluído! Backup: {filename} | {step_summary}"
            else:
                async def _on_rest(line: str, lvl: str) -> None:
                    await logger.log(line, level=lvl, host_name=test_host["name"], step="3/4 RESTORE")

                r_code, _ = await run_ssh_command_stream(test_host, restore_cmd, _on_rest)
                if r_code != 0:
                    raise RuntimeError(f"Etapa 3 (gbak restore) falhou com código {r_code}.")

                if req.run_gfix:
                    await logger.log(
                        "[ETAPA 4/4] Validando integridade física da base restaurada (gfix -v -full -n)...",
                        level="info",
                        host_name=test_host["name"],
                        step="4/4 GFIX",
                    )

                    async def _on_gfix(line: str, lvl: str) -> None:
                        await logger.log(line, level=lvl, host_name=test_host["name"], step="4/4 GFIX")

                    g_code, g_out = await run_ssh_command_stream(test_host, gfix_cmd, _on_gfix)
                    if g_code != 0 or "errors" in g_out.lower():
                        status = "warning"
                        summary = f"Pipeline finalizado com alerta do gfix em {req.test_restore_db_path}."
                    else:
                        status = "success"
                        summary = f"Pipeline Completo homologado! Base {req.test_restore_db_path} íntegra (0 erros)."
                else:
                    status = "success"
                    summary = f"Pipeline Completo finalizado! Base restaurada em {req.test_restore_db_path}."

        await logger.log(
            f"[CONCLUÍDO] {summary}",
            level="success" if status == "success" else "warn",
            host_name="Pipeline",
            step="DONE",
        )

        # Optional Retention Cleanup step
        if req.cleanup_old_backups_days and req.cleanup_old_backups_days > 0:
            days = int(req.cleanup_old_backups_days)
            retention_host = test_host if is_offload else prod_host
            retention_dir = req.test_backup_dir if is_offload else req.prod_backup_dir
            cleanup_cmd = (
                f"find '{retention_dir}' -maxdepth 1 -type f "
                f"\\( -name '*.fbk' -o -name '*.fbk.zst' -o -name '*.fbk.gz' \\) "
                f"-mtime +{days} -delete"
            )
            await logger.log(
                f"[RETENÇÃO] Limpando backups com mais de {days} dias: $ {cleanup_cmd}",
                level="info",
                host_name=retention_host["name"],
                step="RETENTION",
            )
            if not retention_host.get("is_simulated"):
                async def _on_clean(line: str, lvl: str) -> None:
                    await logger.log(line, level=lvl, host_name=retention_host["name"], step="RETENTION")
                await run_ssh_command_stream(retention_host, cleanup_cmd, _on_clean)

        # Optional Webhook Notification step
        if req.webhook_url and req.webhook_url.strip():
            from app.services.scheduler import send_webhook_notification

            await logger.log(
                f"[WEBHOOK] Enviando notificação de conclusão para {req.webhook_url.strip()}...",
                level="info",
                host_name="Pipeline",
                step="NOTIFY",
            )
            sent = await send_webhook_notification(
                webhook_url=req.webhook_url,
                title="Pipeline Completo (1-Clique)",
                status=status,
                summary=summary,
                execution_id=exec_id,
                duration_seconds=time.perf_counter() - t0,
            )
            await logger.log(
                "Notificação Webhook entregue com sucesso!"
                if sent
                else "Aviso: Não foi possível entregar o Webhook (verifique a URL).",
                level="success" if sent else "warn",
                host_name="Pipeline",
                step="NOTIFY",
            )
    except Exception as exc:
        status = "error"
        summary = f"Falha no Pipeline Completo: {exc}"
        await logger.log(summary, level="error", host_name="Pipeline", step="ERROR")
    finally:
        if is_offload and os.path.exists(local_staging_file):
            try:
                os.remove(local_staging_file)
            except OSError:
                pass

    duration = time.perf_counter() - t0
    finalize_execution_record(
        exec_id,
        status,
        duration,
        summary,
        artifact_file=(test_backup_file if is_offload else prod_backup_file) if status != "error" else "",
    )
    await ws_manager.emit_status(
        exec_id,
        status,
        "Job 4: Pipeline Completo (1-Clique)",
        summary,
        duration,
    )


# ---------------------------------------------------------------------------
# Maintenance & Linux Tuning Job Runners (from ROTINAS_MANUTENCAO.md)
# ---------------------------------------------------------------------------

async def execute_maintenance_job(exec_id: int, req: MaintenanceJobRequest) -> None:
    t0 = time.perf_counter()
    logger = ExecutionLogger(exec_id)
    host = get_host_by_id(req.host_id)
    meta = MAINTENANCE_CATALOG.get(req.job_id, {"title": req.job_id})
    job_title = f"Manutenção: {meta['title']}"

    if not host:
        msg = f"Servidor ID {req.host_id} não encontrado."
        await logger.log(msg, level="error")
        finalize_execution_record(exec_id, "error", 0.1, msg)
        await ws_manager.emit_status(exec_id, "error", job_title, msg)
        return

    host_label = host["name"]
    db_path = req.db_path or host.get("default_db_path") or "/dados/venosan_prod.fdb"
    cmd_preview = build_maintenance_command_preview(host, req)

    await logger.log(
        f"Iniciando rotina [{req.job_id}] — {meta['title']} em {host_label} ({host['hostname']})...",
        level="info",
        host_name=host_label,
        step=req.job_id.upper(),
    )
    for cmd_line in mask_sensitive(cmd_preview).splitlines():
        await logger.log(f"$ {cmd_line}", level="cmd", host_name=host_label, step="CMD")

    try:
        if host.get("is_simulated"):
            status, summary = await _simulate_maintenance_routine(
                logger=logger,
                host=host,
                req=req,
                db_path=db_path,
            )
        else:
            async def _on_line(line: str, lvl: str) -> None:
                await logger.log(line, level=lvl, host_name=host_label, step=req.job_id.upper())

            exit_code, output = await run_ssh_command_stream(host, cmd_preview, _on_line)
            if exit_code == 0:
                status = "success"
                summary = f"{meta['title']} executado com sucesso em {host_label}."
                # Check if job_check_health found large transaction gap
                if req.job_id == "job_check_health":
                    m_oat = re.search(r"Oldest active\s+(\d+)", output)
                    m_nxt = re.search(r"Next transaction\s+(\d+)", output)
                    if m_oat and m_nxt:
                        gap = int(m_nxt.group(1)) - int(m_oat.group(1))
                        if gap > req.warn_gap_threshold:
                            status = "warning"
                            summary = f"Alerta de OAT: Gap de transações ({gap}) acima do limite ({req.warn_gap_threshold})!"
                        else:
                            summary = f"Saúde OK: Gap de transações ({gap}) dentro da normalidade."
                await logger.log(summary, level="success" if status == "success" else "warn", host_name=host_label, step="DONE")
            else:
                status = "error"
                summary = f"Rotina {req.job_id} retornou código {exit_code}."
                await logger.log(summary, level="error", host_name=host_label, step="ERROR")
    except Exception as exc:
        status = "error"
        summary = f"Erro durante rotina {req.job_id}: {exc}"
        await logger.log(summary, level="error", host_name=host_label, step="ERROR")

    duration = time.perf_counter() - t0
    finalize_execution_record(exec_id, status, duration, summary)
    await ws_manager.emit_status(exec_id, status, job_title, summary, duration)


async def _simulate_maintenance_routine(
    logger: ExecutionLogger,
    host: Dict[str, Any],
    req: MaintenanceJobRequest,
    db_path: str,
) -> Tuple[str, str]:
    host_label = host["name"]

    if req.job_id == "job_reindex_stats":
        steps = [
            (f"Conectando via isql em {db_path} (100% Online, sem lock exclusivo)...", "info", 0.18),
            ("Consultando RDB$INDICES para índices de usuário ativos (RDB$SYSTEM_FLAG = 0)...", "info", 0.18),
            ("SET STATISTICS INDEX PK_CLIENTES; -> seletividade atualizada: 0.0000067", "info", 0.16),
            ("SET STATISTICS INDEX IDX_CLIENTES_CNPJ; -> seletividade atualizada: 0.0000068", "info", 0.15),
            ("SET STATISTICS INDEX PK_PRODUTOS_VENOSAN; -> seletividade atualizada: 0.0000803", "info", 0.15),
            ("SET STATISTICS INDEX PK_PEDIDOS_VENDA; -> seletividade atualizada: 0.0000011", "info", 0.18),
            ("SET STATISTICS INDEX IDX_PEDIDOS_DT_EMISSAO; -> seletividade atualizada: 0.0004120", "info", 0.18),
            ("SET STATISTICS INDEX FK_ITENS_PEDIDO_PED; -> seletividade atualizada: 0.0000012", "info", 0.18),
            ("SET STATISTICS INDEX IDX_MOV_ESTOQUE_DATA; -> seletividade atualizada: 0.0002890", "info", 0.18),
            ("SET STATISTICS INDEX IDX_NFE_CHAVE_ACESSO; -> seletividade atualizada: 0.0000016", "info", 0.16),
            ("COMMIT; -> 42 índices de usuário recalculados com sucesso para o otimizador Firebird.", "success", 0.15),
        ]
        for msg, lvl, delay in steps:
            await logger.log(msg, level=lvl, host_name=host_label, step="REINDEX_STATS")
            await asyncio.sleep(delay)
        return "success", f"Estatísticas de 42 índices recalculadas online em {db_path}."

    elif req.job_id == "job_check_health":
        oit = 4819200
        oat = 4819215
        ost = 4819215
        next_tx = 4820110
        gap_next_oat = next_tx - oat
        gap_oat_oit = oat - oit

        steps = [
            (f"Lendo Header Page via gstat -h em {db_path}...", "info", 0.18),
            ("Database header page information:", "info", 0.12),
            ("    Flags                   0 (Active, Force Write habilitado)", "info", 0.12),
            ("    Page size               16384 | ODS version: 12.0", "info", 0.12),
            (f"    Oldest transaction (OIT): {oit}", "info", 0.15),
            (f"    Oldest active      (OAT): {oat}", "info", 0.15),
            (f"    Oldest snapshot    (OST): {ost}", "info", 0.15),
            (f"    Next transaction        : {next_tx}", "info", 0.15),
            (
                f"Diagnóstico de Transações: Gap (Next - OAT) = {gap_next_oat} | Gap de Sweep (OAT - OIT) = {gap_oat_oit}",
                "info",
                0.20,
            ),
            (
                "MON$TRANSACTIONS: Nenhuma transação órfã ou presa há mais de 15 minutos detectada.",
                "success",
                0.15,
            ),
        ]
        for msg, lvl, delay in steps:
            await logger.log(msg, level=lvl, host_name=host_label, step="CHECK_HEALTH")
            await asyncio.sleep(delay)

        if gap_next_oat > req.warn_gap_threshold:
            await logger.log(
                f"ALERTA: Gap (Next - OAT = {gap_next_oat}) excede o limite configurado ({req.warn_gap_threshold})!",
                level="warn",
                host_name=host_label,
                step="CHECK_HEALTH",
            )
            return "warning", f"Alerta: Gap Next-OAT ({gap_next_oat}) acima do limite ({req.warn_gap_threshold})."

        return (
            "success",
            f"Saúde do banco aprovada! OIT={oit}, OAT={oat}, Next={next_tx} (Gap Next-OAT: {gap_next_oat}).",
        )

    elif req.job_id == "job_clean_sweep":
        steps = [
            (f"Estado pré-sweep em {db_path}: OIT = 4801100 | OAT = 4819215 (18.115 transações acumuladas)", "info", 0.20),
            ("Iniciando gfix -sweep (Coleta de lixo de backversions obsoletas)...", "info", 0.25),
            ("sweep: varrendo páginas de dados de MOVIMENTO_ESTOQUE (removendo 14.280 backversions)...", "info", 0.28),
            ("sweep: varrendo páginas de dados de ITENS_PEDIDO (removendo 8.910 backversions)...", "info", 0.28),
            ("sweep: varrendo páginas de dados de PEDIDOS_VENDA e TITULOS_FINANCEIRO...", "info", 0.25),
            ("sweep: avançando Oldest Transaction (OIT) de 4801100 -> 4819215", "success", 0.20),
            ("gfix -sweep finalizado! Espaço de páginas liberado para reutilização imediata.", "success", 0.15),
        ]
        for msg, lvl, delay in steps:
            await logger.log(msg, level=lvl, host_name=host_label, step="CLEAN_SWEEP")
            await asyncio.sleep(delay)
        return "success", f"Sweep concluído em {db_path}: 23.190 backversions limpas e OIT avançado para 4819215."

    elif req.job_id == "job_full_rebuild":
        bkp_dir = (req.backup_dir or host.get("default_backup_dir") or "/backups").rstrip("/")
        ts = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d_%H%M%S")
        rebuild_fbk = f"{bkp_dir}/rebuild_{ts}.fbk"
        steps = [
            (
                f"[1/5 SHUTDOWN] Executando gfix -shut full -force {req.force_shutdown_timeout} em {db_path}...",
                "warn",
                0.25,
            ),
            ("Banco colocado em estado FULL SHUTDOWN. Conexões de usuários encerradas com segurança.", "info", 0.20),
            (f"[2/5 BACKUP] Executando gbak -b -v '{db_path}' '{rebuild_fbk}'...", "info", 0.30),
            ("gbak: todas as tabelas, generators, procedures e índices exportados para " + rebuild_fbk, "info", 0.25),
            (f"[3/5 RESTORE] Recriando base limpa com Page Size 16384 em '{db_path}.new'...", "info", 0.30),
            ("gbak: reconstruindo árvores B-Tree e alocando páginas contíguas sem fragmentação...", "info", 0.25),
            (f"[4/5 VALIDATE] Executando gfix -v -full -n em '{db_path}.new' -> 0 erros encontrados!", "success", 0.22),
            (
                f"[5/5 ONLINE] Rotacionando '{db_path}' -> '{db_path}.old', ativando nova base e executando gfix -online...",
                "info",
                0.22,
            ),
            (f"gfix -online concluído! Base {db_path} reconstruída e disponível para produção.", "success", 0.15),
        ]
        for msg, lvl, delay in steps:
            await logger.log(msg, level=lvl, host_name=host_label, step="FULL_REBUILD")
            await asyncio.sleep(delay)
        return "success", f"Ciclo Rebuild completo finalizado! Base {db_path} reorganizada e online (gfix -online)."

    else:  # job_linux_patches
        apply_mode = req.linux_action_mode == "apply_optimizations"
        steps = [
            ("[2.1 I/O fstab] Verificando flags noatime,nodiratime na partição de dados (/dados)...", "info", 0.20),
            (
                "  -> /etc/fstab: UUID=8f4a-991b /dados ext4 defaults,noatime,nodiratime 0 2 [CONFORME]"
                if apply_mode
                else "  -> Mount atual: /dev/nvme0n1p2 on /dados type ext4 (rw,noatime,nodiratime) [CONFORME]",
                "success",
                0.20,
            ),
            ("[2.2 Memória / Swappiness] Verificando parâmetro de kernel vm.swappiness...", "info", 0.20),
            (
                "  -> Aplicado sysctl -w vm.swappiness=10 e persistido em /etc/sysctl.conf [OTIMIZADO]"
                if apply_mode
                else "  -> Valor atual: vm.swappiness = 10 (Priorizando cache de páginas Firebird em RAM) [CONFORME]",
                "success",
                0.20,
            ),
            ("[2.3 SSD/NVMe Trim] Verificando serviço systemd fstrim.timer...", "info", 0.20),
            (
                "  -> Executado: systemctl enable --now fstrim.timer (active/waiting - disparo semanal) [ATIVO]"
                if apply_mode
                else "  -> Status: fstrim.timer enabled / active (último TRIM concluído sem erros) [CONFORME]",
                "success",
                0.20,
            ),
            ("[2.4 Proteção Firebird & Patches SO] Verificando bloqueio de versão do Firebird e updates de segurança...", "info", 0.22),
            (
                "  -> Pacote 'firebird*' travado via apt-mark hold (protegido contra upgrade acidental de ODS)."
                " 3 atualizações de segurança do kernel/OpenSSL disponíveis (sem conflito com Firebird).",
                "success",
                0.20,
            ),
        ]
        for msg, lvl, delay in steps:
            await logger.log(msg, level=lvl, host_name=host_label, step="LINUX_TUNING")
            await asyncio.sleep(delay)
        mode_str = "Otimizações aplicadas e verificadas" if apply_mode else "Auditoria Linux concluída"
        return (
            "success",
            f"{mode_str}: noatime OK, vm.swappiness=10 OK, fstrim.timer ativo, pacote firebird* em hold.",
        )
