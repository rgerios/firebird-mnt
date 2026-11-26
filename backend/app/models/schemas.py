from typing import Literal, Optional
from pydantic import BaseModel, Field


class HostBase(BaseModel):
    name: str = Field(..., description="Nome amigável do servidor")
    role: Literal["production", "testing", "storage"] = Field(
        default="production", description="Papel do servidor"
    )
    hostname: str = Field(..., description="IP ou Hostname")
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root")
    auth_type: Literal["key", "password"] = Field(default="key")
    secret: Optional[str] = Field(
        default="~/.ssh/id_rsa",
        description="Caminho da chave privada SSH ou senha SSH",
    )
    fb_user: str = Field(default="SYSDBA")
    fb_password: Optional[str] = Field(default="masterkey")
    default_db_path: str = Field(default="/dados/producao.fdb")
    default_backup_dir: str = Field(default="/backups")
    is_simulated: bool = Field(
        default=True,
        description="Se ativo, simula execução Firebird/SSH com logs realistas para homologação",
    )


class HostCreate(HostBase):
    pass


class HostUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[Literal["production", "testing", "storage"]] = None
    hostname: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    auth_type: Optional[Literal["key", "password"]] = None
    secret: Optional[str] = None
    fb_user: Optional[str] = None
    fb_password: Optional[str] = None
    default_db_path: Optional[str] = None
    default_backup_dir: Optional[str] = None
    is_simulated: Optional[bool] = None


class BackupJobRequest(BaseModel):
    host_id: int
    db_path: str = Field(..., description="Caminho do arquivo .fdb no servidor de produção")
    backup_dir: str = Field(default="/backups", description="Diretório de destino do backup")
    compression: Literal["zstd", "gzip", "none"] = Field(default="zstd")
    no_gc: bool = Field(
        default=True,
        description="Flag -g: desativa garbage collection durante o backup para evitar impacto em produção",
    )
    verbose: bool = Field(default=True, description="Flag -v: exibe progresso detalhado de tabelas e páginas")


class TransferJobRequest(BaseModel):
    source_host_id: int
    target_host_id: int
    source_file: str = Field(..., description="Caminho completo do arquivo .fbk / .fbk.zst na origem")
    target_dir: str = Field(default="/backups/recebidos", description="Diretório remoto no servidor de destino")
    method: Literal["rsync", "scp"] = Field(default="rsync")


class RestoreValidateJobRequest(BaseModel):
    host_id: int
    backup_file: str = Field(..., description="Caminho do arquivo .fbk / .fbk.zst no servidor de teste")
    restore_db_path: str = Field(..., description="Caminho do .fdb temporário/validado a ser recriado")
    compression: Literal["auto", "zstd", "gzip", "none"] = Field(default="auto")
    replace_existing: bool = Field(
        default=True,
        description="Usa gbak -c -rep para sobrescrever base de teste anterior com segurança",
    )
    run_gfix: bool = Field(
        default=True,
        description="Executa gfix -v -full -n após o restore para validação física de páginas",
    )
    simulate_corruption: bool = Field(
        default=False,
        description="Apenas para modo simulação: injeta anomalia simulada no gfix para testar alerta",
    )


class FullPipelineJobRequest(BaseModel):
    prod_host_id: int
    test_host_id: int
    prod_db_path: str
    prod_backup_dir: str = "/backups"
    test_backup_dir: str = "/backups/recebidos"
    test_restore_db_path: str = "/dados_teste/venosan_valida.fdb"
    compression: Literal["zstd", "gzip", "none"] = "zstd"
    no_gc: bool = True
    transfer_method: Literal["rsync", "scp"] = "rsync"
    run_gfix: bool = True
    cleanup_old_backups_days: Optional[int] = Field(
        default=7, description="Se informado, remove backups mais antigos que N dias após validação"
    )
    webhook_url: Optional[str] = Field(
        default="", description="URL opcional de Webhook (Slack/Discord/Teams/HTTP) para notificação de conclusão"
    )


class MaintenanceJobRequest(BaseModel):
    job_id: Literal[
        "job_reindex_stats",
        "job_check_health",
        "job_clean_sweep",
        "job_full_rebuild",
        "job_linux_patches",
    ] = Field(..., description="ID do job de manutenção conforme ROTINAS_MANUTENCAO.md")
    host_id: int = Field(..., description="ID do servidor alvo")
    db_path: Optional[str] = Field(
        default=None, description="Caminho do banco .fdb (usado nas rotinas Firebird)"
    )
    backup_dir: Optional[str] = Field(
        default="/backups", description="Diretório para arquivos temporários do rebuild"
    )
    warn_gap_threshold: int = Field(
        default=20000, description="Limite de gap (Next - OAT) para disparo de alerta no diagnóstico"
    )
    force_shutdown_timeout: int = Field(
        default=30, description="Segundos para gfix -shut full -force no ciclo de rebuild"
    )
    confirm_downtime: bool = Field(
        default=False,
        description="Confirmação explícita exigida para o job_full_rebuild que requer parada (shutdown)",
    )
    linux_action_mode: Literal["audit_only", "apply_optimizations"] = Field(
        default="audit_only",
        description="No job_linux_patches: apenas audita ou aplica swappiness=10, fstrim.timer e hold firebird*",
    )


class ScheduleCreate(BaseModel):
    name: str
    cron_expr: str = "0 22 * * *"
    prod_host_id: int
    test_host_id: int
    compression: Literal["zstd", "gzip", "none"] = "zstd"
    no_gc: bool = True
    run_gfix: bool = True
    retention_days: int = 7
    webhook_url: Optional[str] = ""
    enabled: bool = True


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=6)


class UserCreateRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=40)
    full_name: str = Field(..., min_length=2, max_length=80)
    password: str = Field(..., min_length=6)
    role: Literal["admin", "operator", "readonly"] = "readonly"


class OfflineAnalyzeRequest(BaseModel):
    db_path: str = Field(..., description="Caminho do arquivo .fdb importado ou localizado no servidor")
    host_id: Optional[int] = Field(
        default=None,
        description="ID do servidor onde o arquivo está (ou null para analisar no container local)",
    )
    simulate_profile: Literal["needs_optimization", "corrupted", "healthy"] = Field(
        default="needs_optimization",
        description="Perfil para simulação de diagnóstico quando em modo homologação",
    )


class OfflineOptimizeRequest(BaseModel):
    db_path: str = Field(..., description="Caminho do arquivo .fdb offline a otimizar/reparar")
    host_id: Optional[int] = Field(default=None)
    action: Literal["sweep", "reindex", "mend", "rebuild_16k", "all"] = Field(
        default="all",
        description="Ação de otimização offline a executar no arquivo .fdb",
    )


