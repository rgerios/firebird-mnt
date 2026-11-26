#!/usr/bin/env bash
set -e

# 1. Garante diretórios persistentes de dados, logs, certificados TLS e chaves SSH
mkdir -p /app/backend/data/logs
mkdir -p /app/backend/data/ssh
mkdir -p /app/backend/data/certs
mkdir -p /app/backend/data/offline_lab
mkdir -p /root/.ssh
chmod 700 /root/.ssh

# 2. Se o host Linux montou chaves em /root/.ssh-host, copia ajustando permissões de root
if [ -d "/root/.ssh-host" ] && [ "$(ls -A /root/.ssh-host 2>/dev/null)" ]; then
    cp -f /root/.ssh-host/* /root/.ssh/ 2>/dev/null || true
fi

# 3. Gera um par de chaves SSH persistente exclusivo do Firebird Command Center caso não exista
if [ ! -f "/app/backend/data/ssh/id_rsa" ] && [ ! -f "/root/.ssh/id_rsa" ]; then
    echo "[Firebird Command Center] Gerando par de chaves SSH persistente em /app/backend/data/ssh/id_rsa..."
    ssh-keygen -t rsa -b 4096 -f /app/backend/data/ssh/id_rsa -N "" -C "firebird-command-center@venosan" >/dev/null 2>&1
fi

if [ -f "/app/backend/data/ssh/id_rsa" ] && [ ! -f "/root/.ssh/id_rsa" ]; then
    cp /app/backend/data/ssh/id_rsa /root/.ssh/id_rsa
    cp /app/backend/data/ssh/id_rsa.pub /root/.ssh/id_rsa.pub
fi

# 4. Ajusta permissões estritas exigidas pelo OpenSSH Client no Linux
chown -R root:root /root/.ssh
chmod 700 /root/.ssh
find /root/.ssh -type f -exec chmod 600 {} \;
find /root/.ssh -name "*.pub" -exec chmod 644 {} \;

if [ ! -f "/root/.ssh/config" ]; then
    cat << 'EOF' > /root/.ssh/config
Host *
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
    ServerAliveCountMax 3
EOF
    chmod 600 /root/.ssh/config
fi

# 5. Gera Certificado SSL/TLS Autoassinado (HTTPS) caso não exista em /app/backend/data/certs/
python3 -c "from app.core.tls import ensure_self_signed_cert; c, k = ensure_self_signed_cert(); print(f'[HTTPS/TLS] Certificado autoassinado pronto: {c}')"

if [ -f "/root/.ssh/id_rsa.pub" ]; then
    echo "========================================================================"
    echo "[Firebird Command Center] Chave Pública SSH do Container:"
    cat /root/.ssh/id_rsa.pub
    echo "========================================================================"
fi

# 6. Inicia listener HTTP secundário na porta 8000 em background e listener HTTPS principal na porta 8443
echo "[Firebird Command Center] Iniciando HTTPS na porta 8443 e HTTP na porta 8000..."
uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips "*" &

exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port 8443 \
    --ssl-keyfile /app/backend/data/certs/key.pem \
    --ssl-certfile /app/backend/data/certs/cert.pem \
    --proxy-headers \
    --forwarded-allow-ips "*"
