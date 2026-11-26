import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.security import hash_password

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "inframgnt.db"


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)


@contextmanager
def get_db():
    ensure_dirs()
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def init_db() -> None:
    ensure_dirs()
    with get_db() as conn:
        cursor = conn.cursor()

        # Users table for Authentication & Access Control
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                full_name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin',
                password_hash TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                last_login_at TEXT DEFAULT NULL,
                created_at TEXT NOT NULL
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS hosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'production',
                hostname TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT NOT NULL DEFAULT 'root',
                auth_type TEXT NOT NULL DEFAULT 'key',
                secret TEXT DEFAULT '',
                fb_user TEXT NOT NULL DEFAULT 'SYSDBA',
                fb_password TEXT NOT NULL DEFAULT 'masterkey',
                default_db_path TEXT NOT NULL DEFAULT '/dados/producao.fdb',
                default_backup_dir TEXT NOT NULL DEFAULT '/backups',
                is_simulated INTEGER NOT NULL DEFAULT 1,
                last_status TEXT NOT NULL DEFAULT 'unknown',
                last_latency_ms REAL DEFAULT NULL,
                firebird_service_status TEXT NOT NULL DEFAULT 'unknown',
                firebird_version TEXT DEFAULT 'Firebird 3.0',
                last_checked_at TEXT DEFAULT NULL,
                created_at TEXT NOT NULL
            )
            """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS executions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type TEXT NOT NULL,
                job_title TEXT NOT NULL,
                source_host_id INTEGER,
                target_host_id INTEGER,
                source_host_name TEXT,
                target_host_name TEXT,
                parameters_json TEXT NOT NULL DEFAULT '{}',
                command_preview TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'running',
                started_at TEXT NOT NULL,
                finished_at TEXT DEFAULT NULL,
                duration_seconds REAL DEFAULT NULL,
                log_file_path TEXT DEFAULT NULL,
                summary TEXT DEFAULT '',
                artifact_file TEXT DEFAULT ''
            )
            """
        )

        cursor.execute("PRAGMA table_info(executions)")
        existing_cols = {row["name"] for row in cursor.fetchall()}
        if "artifact_file" not in existing_cols:
            cursor.execute("ALTER TABLE executions ADD COLUMN artifact_file TEXT DEFAULT ''")

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                cron_expr TEXT NOT NULL DEFAULT '0 22 * * *',
                prod_host_id INTEGER NOT NULL,
                test_host_id INTEGER NOT NULL,
                compression TEXT NOT NULL DEFAULT 'zstd',
                no_gc INTEGER NOT NULL DEFAULT 1,
                run_gfix INTEGER NOT NULL DEFAULT 1,
                retention_days INTEGER NOT NULL DEFAULT 7,
                webhook_url TEXT DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                last_run_at TEXT DEFAULT NULL,
                created_at TEXT NOT NULL
            )
            """
        )

        # Time-series telemetry history table for Temporal Charts (TV NOC Wallboard)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS telemetry_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                sampled_at TEXT NOT NULL,
                time_label TEXT NOT NULL,
                firebird_rss_mb REAL NOT NULL,
                cpu_load_pct REAL NOT NULL,
                active_connections INTEGER NOT NULL,
                disk_io_mbps REAL NOT NULL,
                transaction_gap INTEGER NOT NULL,
                sweep_gap INTEGER NOT NULL,
                latency_ms REAL NOT NULL
            )
            """
        )

        # Daily 24h Database Intelligence Reports table (HTML + Structured Metrics)
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS daily_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                host_name TEXT NOT NULL,
                report_date TEXT NOT NULL,
                period_label TEXT NOT NULL,
                firebird_version TEXT NOT NULL,
                records_added_24h INTEGER NOT NULL,
                records_removed_24h INTEGER NOT NULL,
                net_growth_24h INTEGER NOT NULL,
                size_delta_mb_24h REAL NOT NULL,
                top_growing_table TEXT NOT NULL,
                top_growing_count INTEGER NOT NULL,
                summary_json TEXT NOT NULL,
                html_file_path TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )

        # Seed default Admin User if empty
        cursor.execute("SELECT COUNT(*) as count FROM users")
        u_row = cursor.fetchone()
        if u_row and u_row["count"] == 0:
            default_admin_user = os.environ.get("INFRAMGNT_ADMIN_USER", "admin")
            default_admin_pass = os.environ.get("INFRAMGNT_ADMIN_PASSWORD", "Venosan@2026")
            ts = now_iso()
            cursor.execute(
                """
                INSERT INTO users (username, full_name, role, password_hash, is_active, created_at)
                VALUES (?, ?, 'admin', ?, 1, ?)
                """,
                (
                    default_admin_user,
                    "Administrador Firebird Command Center",
                    hash_password(default_admin_pass),
                    ts,
                ),
            )

        # Always ensure the read-only TV Wallboard user `firebird-ro` exists
        cursor.execute("SELECT id FROM users WHERE username = 'firebird-ro'")
        if not cursor.fetchone():
            ro_pass = os.environ.get("INFRAMGNT_RO_PASSWORD", "VenosanRO@2026")
            ts = now_iso()
            cursor.execute(
                """
                INSERT INTO users (username, full_name, role, password_hash, is_active, created_at)
                VALUES ('firebird-ro', 'Painel TV NOC (Somente Leitura)', 'readonly', ?, 1, ?)
                """,
                (hash_password(ro_pass), ts),
            )

        # Seed default servers if empty so the dashboard works out-of-the-box
        cursor.execute("SELECT COUNT(*) as count FROM hosts")
        row = cursor.fetchone()
        if row and row["count"] == 0:
            ts = now_iso()
            cursor.execute(
                """
                INSERT INTO hosts (
                    name, role, hostname, port, username, auth_type, secret,
                    fb_user, fb_password, default_db_path, default_backup_dir,
                    is_simulated, last_status, last_latency_ms, firebird_service_status,
                    firebird_version, last_checked_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Servidor A - Produção (Venosan)",
                    "production",
                    "192.168.10.10",
                    22,
                    "root",
                    "key",
                    "~/.ssh/id_rsa",
                    "SYSDBA",
                    "masterkey",
                    "/dados/venosan_prod.fdb",
                    "/backups",
                    1,
                    "online",
                    1.8,
                    "active",
                    "Firebird 3.0.10",
                    ts,
                    ts,
                ),
            )
            cursor.execute(
                """
                INSERT INTO hosts (
                    name, role, hostname, port, username, auth_type, secret,
                    fb_user, fb_password, default_db_path, default_backup_dir,
                    is_simulated, last_status, last_latency_ms, firebird_service_status,
                    firebird_version, last_checked_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Servidor B - Teste / Validação",
                    "testing",
                    "192.168.10.20",
                    22,
                    "root",
                    "key",
                    "~/.ssh/id_rsa",
                    "SYSDBA",
                    "masterkey",
                    "/dados_teste/venosan_valida.fdb",
                    "/backups/recebidos",
                    1,
                    "online",
                    2.4,
                    "active",
                    "Firebird 3.0.10",
                    ts,
                    ts,
                ),
            )

        # Seed default nightly schedule if empty
        cursor.execute("SELECT COUNT(*) as count FROM schedules")
        s_row = cursor.fetchone()
        if s_row and s_row["count"] == 0:
            ts = now_iso()
            cursor.execute(
                """
                INSERT INTO schedules (
                    name, cron_expr, prod_host_id, test_host_id,
                    compression, no_gc, run_gfix, retention_days,
                    webhook_url, enabled, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Rotina Noturna — Backup & Homologação Venosan",
                    "0 22 * * *",
                    1,
                    2,
                    "zstd",
                    1,
                    1,
                    7,
                    "",
                    1,
                    ts,
                ),
            )


def dict_from_row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    d = dict(row)
    for bool_col in ("is_simulated", "no_gc", "run_gfix", "enabled", "is_active"):
        if bool_col in d:
            d[bool_col] = bool(d[bool_col])
    return d
