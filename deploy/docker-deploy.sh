#!/usr/bin/env bash
# Script de Deploy Automatizado em Docker no Linux (Debian / Ubuntu / RHEL / Proxmox)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== [1/4] Verificando Docker e Docker Compose no Linux ==="
if ! command -v docker >/dev/null 2>&1; then
    echo "❌ Docker não encontrado. Instale com: curl -fsSL https://get.docker.com | sh"
    exit 1
fi

# Detecta 'docker compose' (plugin v2) ou 'docker-compose' (standalone)
if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
else
    echo "❌ Docker Compose não encontrado. Instale o plugin: apt-get install -y docker-compose-plugin"
    exit 1
fi

echo "=== [2/4] Preparando arquivo .env e diretórios persistentes ==="
mkdir -p backend/data/logs backend/data/ssh

if [ ! -f ".env" ]; then
    cp .env.example .env
    RANDOM_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40)
    sed -i "s/troque-por-uma-chave-aleatoria-segura-em-producao/${RANDOM_SECRET}/" .env
    echo "✅ Arquivo .env gerado com INFRAMGNT_SECRET_KEY exclusiva."
else
    echo "ℹ️ Arquivo .env já existente preservado."
fi

echo "=== [3/4] Construindo e subindo o container InfraMGNT ==="
$COMPOSE_CMD up -d --build

echo "=== [4/4] Aguardando inicialização e Healthcheck ==="
sleep 3
$COMPOSE_CMD ps

echo ""
echo "========================================================================"
echo "✅ Deploy concluído com sucesso!"
echo "🔗 Painel Web: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):8000/login"
echo "🔑 Chave pública SSH gerada pelo container (para autorizar nos servidores Firebird):"
if [ -f "backend/data/ssh/id_rsa.pub" ]; then
    cat backend/data/ssh/id_rsa.pub
else
    $COMPOSE_CMD logs inframgnt | grep -A 2 "Chave Pública SSH" || true
fi
echo "========================================================================"
