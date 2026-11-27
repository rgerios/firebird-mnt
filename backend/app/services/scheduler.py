import asyncio
import json
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.core.database import dict_from_row, get_db, now_iso
from app.models.schemas import FullPipelineJobRequest
from app.services.job_runner import (
    create_execution_record,
    execute_full_pipeline_job,
    get_host_by_id,
)


async def send_webhook_notification(
    webhook_url: str,
    title: str,
    status: str,
    summary: str,
    execution_id: int,
    duration_seconds: float,
) -> bool:
    """
    Sends a completion notification payload compatible with Slack, Discord,
    Microsoft Teams, or generic HTTP Webhook receivers.
    """
    url = (webhook_url or "").strip()
    if not url:
        return False

    emoji = "✅" if status == "success" else "⚠️" if status == "warning" else "❌"
    text_msg = (
        f"{emoji} **[InfraMGNT]** {title} (#{execution_id})\n"
        f"**Status:** `{status.upper()}` | **Duração:** `{duration_seconds:.2f}s`\n"
        f"**Resumo:** {summary}"
    )

    payload = {
        "text": text_msg,
        "content": text_msg,
        "event": "job_completed",
        "execution_id": execution_id,
        "job_title": title,
        "status": status,
        "summary": summary,
        "duration_seconds": round(duration_seconds, 2),
        "timestamp": now_iso(),
    }

    def _sync_post() -> bool:
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=data,
                headers={"Content-Type": "application/json", "User-Agent": "InfraMGNT/1.0"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=6.0) as resp:
                return 200 <= resp.status < 300
        except Exception:
            return False

    return await asyncio.to_thread(_sync_post)


def list_schedules_db() -> List[Dict[str, Any]]:
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM schedules ORDER BY id ASC")
        rows = [dict_from_row(r) for r in cur.fetchall()]
    return [r for r in rows if r is not None]


def get_schedule_by_id(schedule_id: int) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
        return dict_from_row(cur.fetchone())


async def trigger_schedule_execution(schedule_id: int) -> Dict[str, Any]:
    sched = get_schedule_by_id(schedule_id)
    if not sched:
        raise ValueError(f"Agendamento #{schedule_id} não encontrado")

    prod = get_host_by_id(sched["prod_host_id"])
    test = get_host_by_id(sched["test_host_id"])
    if not prod or not test:
        raise ValueError("Servidores vinculados ao agendamento não encontrados")

    ts = now_iso()
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE schedules SET last_run_at = ? WHERE id = ?", (ts, schedule_id))

    req = FullPipelineJobRequest(
        prod_host_id=prod["id"],
        test_host_id=test["id"],
        prod_db_path=prod["default_db_path"],
        prod_backup_dir=prod["default_backup_dir"],
        test_backup_dir=test["default_backup_dir"],
        test_restore_db_path=test["default_db_path"],
        compression=sched.get("compression", "zstd"),
        compression_location=sched.get("compression_location", "source"),
        no_gc=bool(sched.get("no_gc", True)),
        transfer_method="rsync",
        run_restore=bool(sched.get("run_restore", True)),
        run_gfix=bool(sched.get("run_gfix", True)),
        cleanup_old_backups_days=sched.get("retention_days", 7),
        webhook_url=sched.get("webhook_url", ""),
    )

    comp_loc = req.compression_location
    loc_tag = " [Offload App]" if comp_loc != "source" else ""
    restore_tag = f" -> gbak -c ({test['hostname']})" if req.run_restore else " (somente cópia)"
    gfix_tag = " -> gfix" if (req.run_restore and req.run_gfix) else ""
    preview = (
        f"[Agendado: {sched['name']}]{loc_tag} gbak -b -g ({prod['hostname']}) -> "
        f"{req.compression} -> {test['hostname']}{restore_tag}{gfix_tag}"
    )
    exec_id = create_execution_record(
        job_type="full_pipeline",
        job_title=f"Agendamento: {sched['name']}",
        source_host=prod,
        target_host=test,
        params=req.model_dump(),
        command_preview=preview,
    )

    asyncio.create_task(execute_full_pipeline_job(exec_id, req))
    return {"execution_id": exec_id, "schedule_id": schedule_id, "status": "running"}


def _cron_matches_now(cron_expr: str, dt: datetime) -> bool:
    """
    Lightweight 5-field cron evaluator (min hour dom month dow).
    """
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        return False

    fields = [dt.minute, dt.hour, dt.day, dt.month, (dt.weekday() + 1) % 7]
    for expr, val in zip(parts, fields):
        if expr == "*":
            continue
        if expr.startswith("*/"):
            step = int(expr[2:]) if expr[2:].isdigit() else 1
            if val % step != 0:
                return False
        elif "," in expr:
            allowed = [int(x) for x in expr.split(",") if x.isdigit()]
            if val not in allowed:
                return False
        elif expr.isdigit():
            if int(expr) != val:
                return False
        else:
            return False
    return True


async def scheduler_loop() -> None:
    """
    Background loop that:
    1. Collects live Firebird & OS telemetry every 60 seconds (RAM, CPU, IO, Active Conns, TX Gap)
       and records persistent points into `telemetry_samples` for true temporal graphs.
    2. Takes periodic snapshots of table record counts into `table_snapshots` for 24h delta intelligence.
    3. Evaluates cron schedules for automated backup/restore validation pipelines.
    4. Automatically generates the Daily 24h Database Intelligence HTML Report.
    """
    from app.services.daily_report import generate_daily_24h_report, list_daily_reports
    from app.services.firebird_stats import collect_firebird_table_stats, record_table_snapshot
    from app.services.ssh_service import inspect_host_storage_and_gstat

    last_triggered_minute = ""
    last_report_day = ""
    telemetry_tick = 0

    while True:
        try:
            now = datetime.now(timezone.utc).astimezone()
            telemetry_tick += 1

            # -------------------------------------------------------------
            # 1. Telemetry & Table Stats Collector (Every ~60 seconds)
            # -------------------------------------------------------------
            with get_db() as conn:
                cur = conn.cursor()
                cur.execute("SELECT id, name, hostname, role, is_simulated, default_db_path, default_backup_dir, fb_user, fb_password, port, username, auth_type, secret, last_latency_ms FROM hosts WHERE enabled = 1")
                active_hosts = [dict_from_row(r) for r in cur.fetchall()]

            for h in active_hosts:
                try:
                    info = await inspect_host_storage_and_gstat(h, [])
                    lat_ms = float(h.get("last_latency_ms") or 1.8)
                    mem = info.get("memory", {})
                    fb_rss = float(mem.get("firebird_rss_mb") or 0.0)
                    cpu_pct = float(info.get("cpu_load_pct") or 0.0)
                    conns = int(info.get("active_connections") or 0)
                    tx_gap = int(info.get("transaction_gap") or 0)
                    sweep_gap = int(info.get("sweep_gap") or 0)
                    
                    # Disk I/O MB/s estimation from active connections and workload
                    disk_io = round(max(1.2, (conns * 0.28) + (cpu_pct * 0.15)), 1)
                    now_iso_str = now.isoformat(timespec="seconds")
                    time_lbl = now.strftime("%H:%M:%S")

                    with get_db() as conn:
                        cur = conn.cursor()
                        cur.execute(
                            """
                            INSERT INTO telemetry_samples (
                                host_id, sampled_at, time_label, firebird_rss_mb, cpu_load_pct,
                                active_connections, disk_io_mbps, transaction_gap, sweep_gap, latency_ms
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                h["id"],
                                now_iso_str,
                                time_lbl,
                                fb_rss,
                                cpu_pct,
                                conns,
                                disk_io,
                                tx_gap,
                                sweep_gap,
                                lat_ms,
                            ),
                        )
                        # Keep last 1440 samples (24h of 1-minute samples)
                        cur.execute(
                            """
                            DELETE FROM telemetry_samples
                             WHERE host_id = ?
                               AND id NOT IN (
                                   SELECT id FROM telemetry_samples WHERE host_id = ? ORDER BY id DESC LIMIT 1440
                               )
                            """,
                            (h["id"], h["id"]),
                        )

                    # Snapshot table metrics every 10 ticks (~10 minutes)
                    if telemetry_tick % 10 == 1:
                        tbl_stats = await collect_firebird_table_stats(h)
                        if tbl_stats:
                            record_table_snapshot(h["id"], tbl_stats)

                except Exception:
                    pass

            # -------------------------------------------------------------
            # 2. Daily Intelligence 24h Report Check
            # -------------------------------------------------------------
            day_key = now.strftime("%Y-%m-%d")
            if day_key != last_report_day:
                existing = list_daily_reports(limit=1)
                if not existing or not str(existing[0].get("created_at", "")).startswith(day_key):
                    await generate_daily_24h_report(host_id=1)
                last_report_day = day_key

            # -------------------------------------------------------------
            # 3. Scheduled Pipeline Triggers (Cron)
            # -------------------------------------------------------------
            minute_key = now.strftime("%Y-%m-%d %H:%M")
            if minute_key != last_triggered_minute:
                schedules = list_schedules_db()
                for s in schedules:
                    if s.get("enabled") and _cron_matches_now(s.get("cron_expr", ""), now):
                        last_triggered_minute = minute_key
                        await trigger_schedule_execution(s["id"])

        except Exception:
            pass

        await asyncio.sleep(60)


