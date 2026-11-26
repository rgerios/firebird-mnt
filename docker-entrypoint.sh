#!/usr/bin/env bash
set -e

# 1. Garante diretórios persistentes de dados, logs e chaves SSH
mkdir -p /app/backend/data/logs
mkdir -p /app/backend/data/ssh
mkdir -p /root/.ssh
chmod 700 /root/.ssh

# 2. Se o host Linux montou chaves em /root/.ssh-host, copia ajustando permissões de root
if [ -d "/root/.ssh-host" ] && [ "$(ls -A /root/.ssh-host 2>/dev/null)" ]; then
    cp -f /root/.ssh-host/* /root/.ssh/ 2>/dev/null || true
fi

# 3. Gera um par de chaves SSH persistente exclusivo do InfraMGNT caso não exista
if [ ! -f "/app/backend/data/ssh/id_rsa" ] && [ ! -f "/root/.ssh/id_rsa" ]; then
    echo "[InfraMGNT] Gerando par de chaves SSH persistente em /app/backend/data/ssh/id_rsa..."
    ssh-keygen -t rsa -b 4096 -f /app/backend/data/ssh/id_rsa -N "" -C "inframgnt@venosan" >/dev/null 2>&1
fi

# Se houver chave persistente em /app/backend/data/ssh, sincroniza com /root/.ssh
if [ -f "/app/backend/data/ssh/id_rsa" ] && [ ! -f "/root/.ssh/id_rsa" ]; then
    cp /app/backend/data/ssh/id_rsa /root/.ssh/id_rsa
    cp /app/backend/data/ssh/id_rsa.pub /root/.ssh/id_rsa.pub
fi

# 4. Ajusta permissões estritas exigidas pelo OpenSSH Client no Linux
chown -R root:root /root/.ssh
chmod 700 /root/.ssh
find /root/.ssh -type f -exec chmod 600 {} \;
find /root/.ssh -name "*.pub" -exec chmod 644 {} \;

# Configura SSH client para não travar em prompt interativo de host key na primeira conexão
if [ ! -f "/root/.ssh/config" ]; then
    cat << 'EOF' > /root/.ssh/config
Host *
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
    ServerAliveCountMax 3
EOF
    chmod 600 /root/.ssh/config
fi

if [ -f "/root/.ssh/id_rsa.pub" ]; then
    echo "========================================================================"
    echo "[InfraMGNT] Chave Pública SSH do Container (adicione nos servidores A e B):"
    cat /root/.ssh/id_rsa.pub
    echo "========================================================================"
fi

exec "$@"
