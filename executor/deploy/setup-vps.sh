#!/usr/bin/env bash
# 在一台乾淨的 Ubuntu/Debian VPS 上跑這支腳本，把 Bybit Executor 架起來。
#
# 用法：
#   1. 先確認這台 VPS 的地區不是美國（Bybit 會直接擋美國 IP，見專案
#      根目錄 README「為什麼需要 Executor」）
#   2. 把這個 executor/ 資料夾整個上傳到 VPS（scp -r executor/ user@host:/tmp/）
#   3. SSH 進去，以有 sudo 權限的使用者執行：
#        sudo bash /tmp/executor/deploy/setup-vps.sh
#   4. 腳本跑完後，編輯 /opt/smc-executor/executor/.env（從 .env.example
#      複製過來，填好 Bybit 金鑰跟 EXECUTOR_HMAC_SECRET）
#   5. sudo systemctl enable --now smc-executor
#   6. sudo journalctl -u smc-executor -f   看即時 log，確認健康檢查通過
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=/opt/smc-executor
SERVICE_USER=smc-executor

if [ "$EUID" -ne 0 ]; then
  echo "請用 sudo 執行這支腳本" >&2
  exit 1
fi

echo "== 安裝 Node.js 20（如果還沒有的話）=="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oE '^v[0-9]+' | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 建立專用的系統使用者（不給登入權限，最小權限原則）=="
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "== 複製檔案到 $INSTALL_DIR =="
mkdir -p "$INSTALL_DIR"
cp -r "$SRC_DIR" "$INSTALL_DIR/executor"
mkdir -p "$INSTALL_DIR/executor/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

if [ ! -f "$INSTALL_DIR/executor/.env" ]; then
  cp "$INSTALL_DIR/executor/.env.example" "$INSTALL_DIR/executor/.env"
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/executor/.env"
  chmod 600 "$INSTALL_DIR/executor/.env"
  echo "已經建立 $INSTALL_DIR/executor/.env（還是範本內容），部署完務必先編輯這個檔案再啟動服務"
fi

echo "== 裝 systemd 服務 =="
cp "$INSTALL_DIR/executor/deploy/executor.service" /etc/systemd/system/smc-executor.service
systemctl daemon-reload

echo ""
echo "✅ 安裝完成，接下來要做的事："
echo "  1. 編輯 $INSTALL_DIR/executor/.env，填好 BYBIT_API_KEY / BYBIT_API_SECRET / EXECUTOR_HMAC_SECRET"
echo "     （EXECUTOR_HMAC_SECRET 用 openssl rand -hex 32 產生一組，Worker 那邊要設成一模一樣的值）"
echo "  2. sudo systemctl enable --now smc-executor"
echo "  3. sudo journalctl -u smc-executor -f   看 log，確認「健康檢查通過」"
echo "  4. 建議另外設定防火牆／nginx 反向代理加 HTTPS（例如用 Caddy，會自動申請憑證）："
echo "     這支服務本身只有 HTTP，沒有內建 TLS——正式使用前一定要在前面加一層 HTTPS，"
echo "     否則 HMAC 簽章雖然能防偽造，但請求內容（含 API 回應）還是明文，容易被中間人竊聽。"
