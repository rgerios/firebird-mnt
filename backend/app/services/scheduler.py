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
        no_gc=bool(sched.get("no_gc", True)),
        transfer_method="rsync",
        run_gfix=bool(sched.get("run_gfix", True)),
        cleanup_old_backups_days=sched.get("retention_days", 7),
        webhook_url=sched.get("webhook_url", ""),
    )

    preview = (
        f"[Agendado: {sched['name']}] gbak -b -g ({prod['hostname']}) -> "
        f"rsync -> gbak -c -rep ({test['hostname']}) -> gfix -v -full -n"
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
    Background loop that checks active cron schedules every 60 seconds
    and generates the automatic 24h Daily HTML Database Intelligence Report.
    """
    from app.services.daily_report import generate_daily_24h_report, list_daily_reports

    last_triggered_minute = ""
    last_report_day = ""
    while True:
        try:
            now = datetime.now(timezone.utc).astimezone()
            day_key = now.strftime("%Y-%m-%d")
            if day_key != last_report_day:
                existing = list_daily_reports(limit=1)
                if not existing or not str(existing[0].get("created_at", "")).startswith(day_key):
                    await generate_daily_24h_report(host_id=1)
                last_report_day = day_key

            minute_key = now.strftime("%Y-%m-%d %H:%M")
            if minute_key != last_triggered_minute:
                schedules = list_schedules_db()
                for s in schedules:
                    if s.get("enabled") and _cron_matches_now(s.get("cron_expr", ""), now):
                        last_triggered_minute = minute_key
                        await trigger_schedule_execution(s["id"])
        except Exception:
            pass
        await asyncio.sleep(30)

