import asyncio
import os
import random
import re
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Coroutine, Dict, List, Optional, Tuple

import paramiko


def mask_sensitive(cmd: str) -> str:
    """Masks passwords in Firebird and SSH commands before logging."""
    masked = re.sub(r'(-password\s+)(["\']?)([^"\'\s]+)(\2)', r'\1\2********\4', cmd)
    masked = re.sub(r'(ISC_PASSWORD=)(["\']?)([^"\'\s]+)(\2)', r'\1\2********\4', masked)
    return masked


def _build_paramiko_client(host: Dict[str, Any], timeout: float = 8.0) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    hostname = host["hostname"]
    port = int(host.get("port", 22))
    username = host.get("username", "root")
    auth_type = host.get("auth_type", "key")
    secret = (host.get("secret") or "").strip()

    connect_kwargs: Dict[str, Any] = {
        "hostname": hostname,
        "port": port,
        "username": username,
        "timeout": timeout,
        "banner_timeout": timeout,
        "auth_timeout": timeout,
    }

    if auth_type == "password":
        connect_kwargs["password"] = secret
        connect_kwargs["look_for_keys"] = False
    else:
        if secret:
            expanded = os.path.expanduser(secret)
            if os.path.isfile(expanded):
                connect_kwargs["key_filename"] = expanded
            else:
                connect_kwargs["look_for_keys"] = True
        else:
            connect_kwargs["look_for_keys"] = True

    client.connect(**connect_kwargs)
    return client


async def check_host_health(host: Dict[str, Any]) -> Dict[str, Any]:
    """
    Tests connectivity, SSH latency and Firebird service status (`systemctl is-active firebird*`).
    Supports both simulated hosts and real SSH servers.
    """
    if host.get("is_simulated"):
        await asyncio.sleep(0.2)
        latency = round(random.uniform(1.1, 3.8), 2)
        return {
            "status": "online",
            "latency_ms": latency,
            "firebird_service_status": "active",
            "firebird_version": host.get("firebird_version") or "Firebird 3.0.10 (Simulado)",
            "details": "Host em modo simulação — SSH e serviço firebird-superserver operacionais.",
        }

    hostname = host["hostname"]
    port = int(host.get("port", 22))

    def _sync_check() -> Dict[str, Any]:
        t0 = time.perf_counter()
        try:
            with socket.create_connection((hostname, port), timeout=5.0):
                latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        except Exception as exc:
            return {
                "status": "offline",
                "latency_ms": None,
                "firebird_service_status": "unknown",
                "firebird_version": host.get("firebird_version") or "Desconhecido",
                "details": f"Falha de conexão TCP em {hostname}:{port} ({exc})",
            }

        try:
            client = _build_paramiko_client(host, timeout=6.0)
            try:
                check_cmd = (
                    "if systemctl list-units --full -all 2>/dev/null | grep -qi firebird; then "
                    "  systemctl is-active 'firebird*' 2>/dev/null | head -n 1; "
                    "elif pgrep -f 'fbguard|firebird|fb_inet_server|fbserver' >/dev/null 2>&1; then "
                    "  echo active; "
                    "else "
                    "  echo inactive; "
                    "fi"
                )
                _, stdout, _ = client.exec_command(check_cmd, timeout=6.0)
                fb_state = stdout.read().decode("utf-8", errors="replace").strip()
                if "active" in fb_state and "inactive" not in fb_state:
                    fb_status = "active"
                elif fb_state:
                    fb_status = "inactive"
                else:
                    fb_status = "unknown"

                ver_cmd = "gbak -Z 2>&1 | head -n 1 || /opt/firebird/bin/gbak -Z 2>&1 | head -n 1 || echo 'Firebird Linux'"
                _, v_out, _ = client.exec_command(ver_cmd, timeout=5.0)
                fb_ver = v_out.read().decode("utf-8", errors="replace").strip()
                if "gbak:" in fb_ver:
                    fb_ver = fb_ver.replace("gbak:", "").strip()

                return {
                    "status": "online",
                    "latency_ms": latency_ms,
                    "firebird_service_status": fb_status,
                    "firebird_version": fb_ver[:45] if fb_ver else "Firebird Server",
                    "details": f"Conexão SSH autenticada ({latency_ms} ms). Serviço Firebird: {fb_status}.",
                }
            finally:
                client.close()
        except Exception as ssh_exc:
            return {
                "status": "online",
                "latency_ms": latency_ms,
                "firebird_service_status": "unknown",
                "firebird_version": host.get("firebird_version") or "Firebird",
                "details": f"Porta SSH acessível ({latency_ms} ms), mas falha na autenticação SSH: {ssh_exc}",
            }

    return await asyncio.to_thread(_sync_check)


async def inspect_host_storage_and_gstat(
    host: Dict[str, Any], recent_artifacts: List[str]
) -> Dict[str, Any]:
    """
    Inspects Firebird Header Page (`gstat -h`), disk usage (`df -h`),
    database `.fdb` size, and lists backup files in `default_backup_dir`.
    """
    db_path = host.get("default_db_path", "/dados/producao.fdb")
    bkp_dir = host.get("default_backup_dir", "/backups").rstrip("/")
    fb_user = host.get("fb_user") or "SYSDBA"
    fb_pass = host.get("fb_password") or "masterkey"

    if host.get("is_simulated"):
        await asyncio.sleep(0.15)
        ts_str = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        is_prod = host.get("role") == "production"
        oit = 4819200 if is_prod else 104
        oat = 4819215 if is_prod else 105
        next_tx = 4820110 if is_prod else 112
        gap = next_tx - oat

        gstat_text = (
            f"Database \"{db_path}\"\n"
            f"Database header page information:\n"
            f"    Flags                   0\n"
            f"    Generation              {next_tx + 45}\n"
            f"    System Change Number    0\n"
            f"    Page size               16384\n"
            f"    ODS version             12.0\n"
            f"    Oldest transaction      {oit}\n"
            f"    Oldest active           {oat}\n"
            f"    Oldest snapshot         {oat}\n"
            f"    Next transaction        {next_tx}\n"
            f"    Sequence number         0\n"
            f"    Next attachment ID      1842\n"
            f"    Implementation          HW=AMD/Intel/x64 little-endian OS=Linux\n"
            f"    Shadow count            0\n"
            f"    Page buffers            20480\n"
            f"    Database dialect        3\n"
            f"    Creation date           Jan 14, 2024 08:12:09\n"
            f"    Attributes              force write"
        )

        # Build realistic backup list combining recent executed backups + defaults
        files = []
        seen = set()
        for art in recent_artifacts:
            if art and art not in seen:
                seen.add(art)
                files.append(
                    {
                        "path": f"{bkp_dir}/{os.path.basename(art)}",
                        "name": os.path.basename(art),
                        "size": "1.42 GB",
                        "modified": ts_str,
                    }
                )
        default_sample = f"{bkp_dir}/venosan_prod_20261109_220000.fbk.zst"
        if default_sample not in seen:
            files.append(
                {
                    "path": default_sample,
                    "name": os.path.basename(default_sample),
                    "size": "1.41 GB",
                    "modified": "2026-11-09 22:04:12",
                }
            )

        return {
            "host_id": host["id"],
            "host_name": host["name"],
            "is_simulated": True,
            "db_path": db_path,
            "db_size": "6.84 GB",
            "backup_dir": bkp_dir,
            "disk_total": "500 GB",
            "disk_used": "184 GB (37%)" if is_prod else "92 GB (18%)",
            "disk_free": "316 GB" if is_prod else "408 GB",
            "ods_version": "12.0 (Firebird 3.0)",
            "page_size": 16384,
            "oldest_transaction": oit,
            "oldest_active": oat,
            "next_transaction": next_tx,
            "transaction_gap": gap,
            "gstat_raw": gstat_text,
            "backup_files": files,
        }

    def _sync_inspect() -> Dict[str, Any]:
        client = _build_paramiko_client(host, timeout=8.0)
        try:
            # 1. Disk space
            _, df_out, _ = client.exec_command(
                f"df -h '{bkp_dir}' 2>/dev/null | tail -n 1 || df -h / | tail -n 1",
                timeout=6.0,
            )
            df_line = df_out.read().decode("utf-8", errors="replace").strip().split()
            disk_total = df_line[1] if len(df_line) > 4 else "N/A"
            disk_used = f"{df_line[2]} ({df_line[4]})" if len(df_line) > 4 else "N/A"
            disk_free = df_line[3] if len(df_line) > 4 else "N/A"

            # 2. DB Size
            _, sz_out, _ = client.exec_command(
                f"ls -lh '{db_path}' 2>/dev/null | awk '{{print $5}}'", timeout=5.0
            )
            db_size = sz_out.read().decode("utf-8", errors="replace").strip() or "N/A"

            # 3. gstat -h
            gstat_cmd = f"gstat -h -user {fb_user} -password \"{fb_pass}\" '{db_path}' 2>&1"
            _, gs_out, _ = client.exec_command(gstat_cmd, timeout=8.0)
            gstat_raw = gs_out.read().decode("utf-8", errors="replace").strip()

            def _extract_int(pattern: str) -> int:
                m = re.search(pattern, gstat_raw, re.IGNORECASE)
                return int(m.group(1)) if m else 0

            page_size = _extract_int(r"Page size\s+(\d+)")
            oit = _extract_int(r"Oldest transaction\s+(\d+)")
            oat = _extract_int(r"Oldest active\s+(\d+)")
            next_tx = _extract_int(r"Next transaction\s+(\d+)")
            ods_m = re.search(r"ODS version\s+([\d\.]+)", gstat_raw, re.IGNORECASE)
            ods_version = ods_m.group(1) if ods_m else "N/A"

            # 4. Backup files list
            ls_cmd = (
                f"ls -lt --time-style='+%Y-%m-%d %H:%M:%S' '{bkp_dir}' 2>/dev/null "
                f"| grep -E '\\.(fbk|zst|gz)$' | head -n 15"
            )
            _, ls_out, _ = client.exec_command(ls_cmd, timeout=6.0)
            backup_files = []
            for line in ls_out.read().decode("utf-8", errors="replace").splitlines():
                parts = line.split()
                if len(parts) >= 8:
                    fname = parts[-1]
                    size_bytes = int(parts[4]) if parts[4].isdigit() else 0
                    size_mb = f"{size_bytes / (1024 * 1024):.1f} MB"
                    backup_files.append(
                        {
                            "path": f"{bkp_dir}/{fname}",
                            "name": fname,
                            "size": size_mb,
                            "modified": f"{parts[5]} {parts[6]}",
                        }
                    )

            return {
                "host_id": host["id"],
                "host_name": host["name"],
                "is_simulated": False,
                "db_path": db_path,
                "db_size": db_size,
                "backup_dir": bkp_dir,
                "disk_total": disk_total,
                "disk_used": disk_used,
                "disk_free": disk_free,
                "ods_version": ods_version,
                "page_size": page_size,
                "oldest_transaction": oit,
                "oldest_active": oat,
                "next_transaction": next_tx,
                "transaction_gap": max(0, next_tx - oat),
                "gstat_raw": gstat_raw,
                "backup_files": backup_files,
            }
        finally:
            client.close()

    return await asyncio.to_thread(_sync_inspect)


LogCallback = Callable[[str, str], Coroutine[Any, Any, None]]


async def run_ssh_command_stream(
    host: Dict[str, Any],
    command: str,
    on_line: LogCallback,
) -> Tuple[int, str]:
    """
    Executes a shell command on a remote host via SSH and streams stdout/stderr
    line by line to `on_line(line, level)`.
    Returns (exit_code, full_output).
    """
    loop = asyncio.get_running_loop()
    collected_lines = []

    def _sync_exec() -> int:
        client = _build_paramiko_client(host, timeout=12.0)
        try:
            transport = client.get_transport()
            if transport is None:
                raise RuntimeError("Falha ao obter transporte SSH.")
            channel = transport.open_session()
            channel.set_combine_stderr(True)
            channel.exec_command(command)

            buffer = ""
            while True:
                if channel.recv_ready():
                    chunk = channel.recv(4096).decode("utf-8", errors="replace")
                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        clean_line = line.rstrip("\r")
                        collected_lines.append(clean_line)
                        lvl = _classify_line_level(clean_line)
                        asyncio.run_coroutine_threadsafe(on_line(clean_line, lvl), loop).result()
                elif channel.exit_status_ready():
                    while channel.recv_ready():
                        chunk = channel.recv(4096).decode("utf-8", errors="replace")
                        buffer += chunk
                    if buffer.strip():
                        for line in buffer.splitlines():
                            clean_line = line.rstrip("\r")
                            collected_lines.append(clean_line)
                            lvl = _classify_line_level(clean_line)
                            asyncio.run_coroutine_threadsafe(on_line(clean_line, lvl), loop).result()
                    break
                else:
                    time.sleep(0.05)

            return channel.recv_exit_status()
        finally:
            client.close()

    exit_code = await asyncio.to_thread(_sync_exec)
    return exit_code, "\n".join(collected_lines)


async def relay_transfer_between_hosts(
    source_host: Dict[str, Any],
    target_host: Dict[str, Any],
    source_file: str,
    target_dir: str,
    method: str,
    on_line: LogCallback,
) -> Tuple[int, str]:
    """
    Transfers a backup file from Source Host to Target Host.
    First tries direct rsync/scp from Source Host to Target Host.
    If direct host-to-host SSH fails (e.g., no direct SSH key between A and B),
    automatically relays via SFTP stream through the InfraMGNT server.
    """
    target_ip = target_host["hostname"]
    target_port = int(target_host.get("port", 22))
    target_user = target_host.get("username", "root")
    filename = os.path.basename(source_file.rstrip("/"))
    remote_target_path = f"{target_dir.rstrip('/')}/{filename}"

    if method == "rsync":
        direct_cmd = (
            f"rsync -avz --progress -e 'ssh -p {target_port} -o StrictHostKeyChecking=no -o BatchMode=yes' "
            f"'{source_file}' '{target_user}@{target_ip}:{remote_target_path}'"
        )
    else:
        direct_cmd = (
            f"scp -P {target_port} -o StrictHostKeyChecking=no -o BatchMode=yes "
            f"'{source_file}' '{target_user}@{target_ip}:{remote_target_path}'"
        )

    await on_line(
        f"$ {direct_cmd}",
        "cmd",
    )

    mkdir_code, _ = await run_ssh_command_stream(
        target_host, f"mkdir -p '{target_dir}'", on_line
    )
    if mkdir_code != 0:
        return mkdir_code, remote_target_path

    code, _ = await run_ssh_command_stream(source_host, direct_cmd, on_line)
    if code == 0:
        return 0, remote_target_path

    await on_line(
        "Transferência direta A -> B sem chave mútua detectada. Iniciando Relay SFTP seguro via InfraMGNT Server...",
        "warn",
    )
    loop = asyncio.get_running_loop()

    def _sftp_bridge() -> int:
        src_client = _build_paramiko_client(source_host, timeout=15.0)
        dst_client = _build_paramiko_client(target_host, timeout=15.0)
        try:
            src_sftp = src_client.open_sftp()
            dst_sftp = dst_client.open_sftp()
            stat_info = src_sftp.stat(source_file)
            total_bytes = stat_info.st_size or 1
            transferred = 0
            last_pct = -10

            with src_sftp.open(source_file, "rb") as rf, dst_sftp.open(remote_target_path, "wb") as wf:
                while True:
                    chunk = rf.read(256 * 1024)
                    if not chunk:
                        break
                    wf.write(chunk)
                    transferred += len(chunk)
                    pct = int((transferred / total_bytes) * 100)
                    if pct >= last_pct + 20 or transferred == total_bytes:
                        last_pct = pct
                        mb_done = transferred / (1024 * 1024)
                        mb_tot = total_bytes / (1024 * 1024)
                        msg = f"[SFTP Relay] {filename}: {pct}% ({mb_done:.2f} MB / {mb_tot:.2f} MB)"
                        asyncio.run_coroutine_threadsafe(on_line(msg, "info"), loop).result()
            return 0
        finally:
            src_client.close()
            dst_client.close()

    bridge_code = await asyncio.to_thread(_sftp_bridge)
    return bridge_code, remote_target_path


def _classify_line_level(line: str) -> str:
    lower = line.lower()
    if any(k in lower for k in ["error", "fatal", "corrupt", "failed", "exception", "unavailable"]):
        return "error"
    if any(k in lower for k in ["warning", "warn", "orphan", "checksum"]):
        return "warn"
    if any(k in lower for k in ["success", "concluído", "finishing", "closing, and going home"]):
        return "success"
    return "info"
