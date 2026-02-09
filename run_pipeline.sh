#!/usr/bin/env bash
set -euo pipefail

# -------------------------
# Config (edit as you like)
# -------------------------
TOTAL_TX="${TOTAL_TX:-10000}"
USER_COUNT="${USER_COUNT:-100}"
SEED="${SEED:-1337}"
SHARD_SIZE="${SHARD_SIZE:-5000}"
CHECKPOINT_EVERY="${CHECKPOINT_EVERY:-500}"
SNAPSHOT_USER_CAP="${SNAPSHOT_USER_CAP:-120}"

ANVIL_PORT="${ANVIL_PORT:-8545}"
CHAIN_ID="${CHAIN_ID:-31337}"
ACCOUNTS="${ACCOUNTS:-1200}"
BALANCE="${BALANCE:-1000}"
MNEMONIC="${MNEMONIC:-test test test test test test test test test test test junk}"

HARDHAT_BIN="./node_modules/.bin/hardhat"

echo "==> Starting Anvil on port ${ANVIL_PORT} (chainId ${CHAIN_ID})..."
anvil \
  --chain-id "${CHAIN_ID}" \
  --port "${ANVIL_PORT}" \
  --accounts "${ACCOUNTS}" \
  --balance "${BALANCE}" \
  --mnemonic "${MNEMONIC}" \
  > anvil.log 2>&1 &

ANVIL_PID=$!

cleanup() {
  echo "==> Stopping Anvil (pid ${ANVIL_PID})..."
  kill "${ANVIL_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait until RPC is live
echo "==> Waiting for Anvil RPC..."
for i in {1..50}; do
  if curl -s "http://127.0.0.1:${ANVIL_PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "==> Running pipeline_all.js"
TOTAL_TX="${TOTAL_TX}" \
USER_COUNT="${USER_COUNT}" \
SEED="${SEED}" \
SHARD_SIZE="${SHARD_SIZE}" \
CHECKPOINT_EVERY="${CHECKPOINT_EVERY}" \
SNAPSHOT_USER_CAP="${SNAPSHOT_USER_CAP}" \
"${HARDHAT_BIN}" run scripts/pipeline_all_v2.js --network localhost

echo "==> Done. Bundles are in evidence_runs/RUN_*"
