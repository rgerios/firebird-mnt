#!/usr/bin/env bash
# Script de provisionamento rápido do InfraMGNT em Container LXC Proxmox (Debian 12 / Ubuntu 22.04+)
set -euo pipefail

echo "=== [1/4] Instalando dependências do sistema no Container LXC ==="
apt-get update
apt-get install -y python3 python3-venv python3-pip openssh-client rsync zstd gzip curl

echo "=== [2/4] Configurando diretório /opt/inframgnt ==="
mkdir -p /opt/inframgnt
cp -r backend frontend requirements.txt /opt/inframgnt/

echo "=== [3/4] Criando ambiente virtual Python e instalando pacotes ==="
python3 -m venv /opt/inframgnt/.venv
/opt/inframgnt/.venv/bin/pip install --upgrade pip
/opt/inframgnt/.venv/bin/pip install -r /opt/inframgnt/backend/requirements.txt

echo "=== [4/4] Ativando serviço Systemd (inframgnt.service) ==="
cp deploy/inframgnt.service /etc/systemd/system/inframgnt.service
# Gera uma chave secreta aleatória exclusiva para este container Proxmox
RANDOM_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')
sed -i "s/troque-esta-chave-secreta-em-producao-proxmox/${RANDOM_SECRET}/" /etc/systemd/system/inframgnt.service

systemctl daemon-reload
systemctl enable --now inframgnt.service

echo "✅ InfraMGNT instalado e ativo na porta 8000!"
echo "Acesse http://<IP_DO_LXC>:8000/login (Usuário inicial: admin / Senha inicial: Venosan@2026)"

