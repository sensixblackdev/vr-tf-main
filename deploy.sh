#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/vr-tf-main"
REPO_URL="https://github.com/sensixblackdev/vr-tf-main.git"

echo "=== [1/6] Sincronizando repositório em $APP_DIR ==="
if [ ! -d "$APP_DIR/.git" ]; then
    mkdir -p "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
else
    cd "$APP_DIR"
    git fetch origin main
    git reset --hard origin/main
fi

cd "$APP_DIR"

echo "=== [2/6] Instalando dependências Node.js ==="
npm install --omit=dev

echo "=== [3/6] Configurando ambiente Python & Playwright ==="
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
./venv/bin/playwright install-deps || true
./venv/bin/playwright install chromium

echo "=== [4/6] Configurando arquivos de persistência ==="
[ -f dados.json ] || echo "[]" > dados.json
[ -f resultado.json ] || echo "[]" > resultado.json
chmod 666 dados.json resultado.json

echo "=== [5/6] Instalando e Reiniciando Serviços Systemd ==="
cp systemd/vr-web.service /etc/systemd/system/
cp systemd/vr-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable vr-worker.service vr-web.service
systemctl restart vr-worker.service
systemctl restart vr-web.service

echo "=== [6/6] Verificando integridade local ==="
sleep 3
systemctl is-active --quiet vr-web.service && echo "vr-web: ATIVO" || (systemctl status vr-web.service --no-pager && exit 1)
systemctl is-active --quiet vr-worker.service && echo "vr-worker: ATIVO" || (systemctl status vr-worker.service --no-pager && exit 1)
curl -fsS http://127.0.0.1:3000/health || exit 1
echo ""
echo "=== Deploy finalizado com sucesso factual na VPS! ==="
