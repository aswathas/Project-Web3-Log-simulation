# Forensics-Sim v2: Quick Reference & Query Guide

## File Manifest

### RAW Data (On-Chain Primitives)

| File | Doc Type | Source | Format |
|------|----------|--------|--------|
| `RAW/chain/blocks_*.ndjson` | `block` | ethers.getBlock | complete block object |
| `RAW/chain/txs_*.ndjson` | `tx` | ethers.getTransaction | transaction object |
| `RAW/chain/receipts_*.ndjson` | `receipt` | ethers.getTransactionReceipt | receipt object |
| `RAW/chain/logs_events_*.ndjson` | `log` | receipt.logs | event log with tx_hash |
| `RAW/execution/traces_call_*.ndjson` | `trace_call` | debug_traceTransaction(callTracer) | full call tree |
| `RAW/state/snapshots_balances_*.ndjson` | `balance_snapshot` | ethers.getBalance | ETH balance at block |
| `RAW/state/state_diff_*.ndjson` | `state_diff` | debug_traceTransaction(prestateTracer) | pre-state only (Anvil) |
| `RAW/state/token_balance_snapshots_*.ndjson` | `token_balance_snapshot` | ERC20.balanceOf() | token balance snapshot |
| `RAW/state/storage_snapshots_*.ndjson` | `storage_snapshot` | ethers.getStorageAt | storage slot value |
| `RAW/code/codes_*.ndjson` | `code` | ethers.getCode | contract bytecode |
| `RAW/code/token_meta_*.ndjson` | `token_meta` | ERC20 metadata | name, symbol, decimals |

### DERIVED Data (Forensic Enrichments)

#### Timeline & Ordering
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/timeline/tx_enriched_*.ndjson` | `tx_enriched` | Enriched transaction with status & timing | tx_hash, block_number, status, method_id, tx_index |
| `DERIVED/timeline/block_tx_order_*.ndjson` | `block_tx_order` | Transaction ordering per block | block_number, tx_hash, tx_index |
| `DERIVED/timeline/contract_calls_*.ndjson` | `contract_call` | Contract interaction record | from, to, method_id, status, gas_used |

#### Fund Flows
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/flows/asset_transfers_*.ndjson` | `asset_transfer` | Token transfer events | asset_type (native/erc20), from, to, amount |
| `DERIVED/flows/internal_native_transfers_*.ndjson` | `internal_native_transfer` | Call instructions with ETH | from, to, value_wei, call_type, depth |
| `DERIVED/flows/fund_flow_edges_*.ndjson` | `fund_flow_edge` | Transfer as graph edge | asset, from, to, amount |

#### Behavior Analysis
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/behavior/address_profile_*.ndjson` | `address_profile` | Complete address activity | tx_in/out_count, gas_spent, eth/erc20 in/out, call_targets |
| `DERIVED/behavior/method_stats_*.ndjson` | `method_stat` | Aggregated method statistics | to, method_id, count, success/revert_count, unique_callers |

#### Execution & Errors
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/execution/trace_edges_*.ndjson` | `trace_edge` | Call graph edges | caller, callee, call_type, value, depth |
| `DERIVED/execution/revert_reasons_*.ndjson` | `revert_reason` | Decoded revert messages | tx_hash, reason (or null) |

#### ERC20 Approvals & Usage
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/approvals/approvals_*.ndjson` | `approval` | Approval events | token, owner, spender, value |
| `DERIVED/approvals/allowance_edges_*.ndjson` | `allowance_edge` | Approval as directed edge | token, from (owner), to (spender), amount |
| `DERIVED/approvals/allowance_usage_*.ndjson` | `allowance_usage` | Links approval to transferFrom | token, owner, spender, approved/used amounts |

#### Governance & Admin
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/governance/admin_changes_*.ndjson` | `admin_changes` | Critical slot modifications | contract, slot, from_value, to_value, interpretation |
| `DERIVED/governance/critical_slot_deltas_*.ndjson` | `critical_slot_deltas` | Storage changes in known slots | contract, slot, values before/after |

#### Account Balances
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/balances/token_balance_deltas_*.ndjson` | `token_balance_delta` | Token balance changes | token, address, from_balance, to_balance, delta |

#### Mempool (SIM-only)
| File | Doc Type | Purpose | Key Fields |
|------|----------|---------|-----------|
| `DERIVED/mempool/mempool_observed_*.ndjson` | `mempool_pending` | Pending transactions | from, to, value, gasPrice, is_sim_only: true |

---

## Common Forensic Queries

### 1. MEV / Front-Running Detection

```bash
# Get all txs in a block, ordered by position
jq -s 'group_by(.block_number) | .[] | sort_by(.tx_index)' \
  DERIVED/timeline/block_tx_order_*.ndjson

# Detect sandwich: same address at position 0 and 2
jq -s 'group_by(.block_number) | .[] | 
  select(any(.from == .[2].from and .[0].from == .[2].from))' \
  DERIVED/timeline/contract_calls_*.ndjson
```

### 2. Allowance Abuse

```bash
# Find all allowance_usage events
jq '.' DERIVED/approvals/allowance_usage_*.ndjson

# Filter: used more than approved
jq 'select((.used_amount | tonumber) > (.approved_amount | tonumber))' \
  DERIVED/approvals/allowance_usage_*.ndjson

# Find top exploited owners
jq -s 'group_by(.owner) | map({owner: .[0].owner, count: length})' \
  DERIVED/approvals/allowance_usage_*.ndjson
```

### 3. Reentrancy Detection

```bash
# Find internal ETH transfers (indicative of re-entrancy)
jq 'select(.value_wei | tonumber > 0)' \
  DERIVED/flows/internal_native_transfers_*.ndjson

# Same tx with multiple internal transfers to same recipient
jq -s 'group_by(.tx_hash) | 
  map(select(length > 1 and .[0].to == .[1].to)) | .[]' \
  DERIVED/flows/internal_native_transfers_*.ndjson
```

### 4. Price Manipulation / Slippage

```bash
# Large token swaps by address
jq -s 'map(select(.asset_type == "erc20")) | 
  group_by([.from, .asset]) | 
  map(select(length > 3)) | .[]' \
  DERIVED/flows/asset_transfers_*.ndjson

# Top senders by volume
jq -s 'map(select(.asset_type == "erc20")) | 
  group_by(.from) | 
  map({from: .[0].from, volume: (map(.amount | tonumber) | add)}) | 
  sort_by(.volume) | reverse | .[0:10]' \
  DERIVED/flows/asset_transfers_*.ndjson
```

### 5. Admin Privilege Escalation

```bash
# Find all admin changes
jq '.' DERIVED/governance/admin_changes_*.ndjson

# By contract
jq -s 'group_by(.contract)' \
  DERIVED/governance/admin_changes_*.ndjson
```

### 6. Gas Usage Analysis

```bash
# High gas consumers
jq -s 'map(.gas_spent_wei | tonumber) | 
  add as $total | 
  {total: $total, avg: ($total / length)}' \
  DERIVED/behavior/address_profile_*.ndjson

# By method
jq -s 'sort_by(.count) | reverse | .[0:10]' \
  DERIVED/behavior/method_stats_*.ndjson
```

### 7. Address Risk Scoring

```bash
# Addresses with unusual patterns
jq 'select(.tx_out_count > 100) | 
  select(.tx_in_count < 5) | 
  {address: .address, out_txs: .tx_out_count, targets: (.call_targets | length)}' \
  DERIVED/behavior/address_profile_*.ndjson
```

### 8. Event Timeline

```bash
# All transfers in chronological order
jq -s 'sort_by(.timestamp)' \
  DERIVED/flows/asset_transfers_*.ndjson

# By address
jq -s 'map(select(.from == "0x...")) | sort_by(.timestamp)' \
  DERIVED/flows/asset_transfers_*.ndjson
```

### 9. Revert Patterns

```bash
# All reverted txs
jq '.' DERIVED/execution/revert_reasons_*.ndjson

# Most common reason
jq -s 'group_by(.reason) | map({reason: .[0].reason, count: length})' \
  DERIVED/execution/revert_reasons_*.ndjson

# By contract/method
jq -s 'map(select(.reason != null)) | group_by(.reason)' \
  DERIVED/execution/revert_reasons_*.ndjson
```

### 10. Fund Distribution Network

```bash
# Build fund flow graph (manual, requires tool like Cypher)
jq '{source: .from, target: .to, value: .amount}' \
  DERIVED/flows/fund_flow_edges_*.ndjson > fund_graph.jsonl

# Most connected recipients
jq -s 'group_by(.to) | map({address: .[0].to, inbound: length})' \
  DERIVED/flows/fund_flow_edges_*.ndjson
```

---

## Data Quality Checks

### Completeness

```bash
# Count records in each document type
for type in block tx receipt log trace_call balance_snapshot; do
  echo "$type: $(jq -s 'length' RAW/*/${type}*.ndjson | paste -sd+ | bc)"
done

for type in tx_enriched block_tx_order contract_call; do
  echo "$type: $(jq -s 'length' DERIVED/*/${type}*.ndjson | paste -sd+ | bc)"
done
```

### Consistency Checks

```bash
# All balance snapshots have valid addresses
jq 'select(.address == null or .address !~ "^0x[0-9a-f]{40}$")' \
  RAW/state/snapshots_balances_*.ndjson

# All transfers have both endpoints
jq 'select(.from == null or .to == null)' \
  DERIVED/flows/asset_transfers_*.ndjson

# All approvals have valid amounts
jq 'select(.value == null or (.value | tonumber) < 0)' \
  DERIVED/approvals/approvals_*.ndjson
```

### Temporal Consistency

```bash
# Transactions should be ordered by block then index
jq -s 'sort_by([.block_number, .tx_index]) | 
  map(.tx_hash) as $sorted | 
  map(.tx_hash) as $actual |
  select($sorted != $actual)' \
  DERIVED/timeline/block_tx_order_*.ndjson

# Timestamps should be monotonic per block
jq -s 'group_by(.block_number) | 
  .[] | 
  map(.timestamp) | 
  select(. != sort)' \
  DERIVED/timeline/tx_enriched_*.ndjson
```

---

## Integration with Tools

### With `jq` (default)
See queries above.

### With `DuckDB`

```sql
-- Load NDJSON
SELECT count(*) as tx_count FROM read_ndjson_auto('DERIVED/timeline/tx_enriched_*.ndjson');

-- Find slow txs
SELECT tx_hash, gas_used 
FROM read_ndjson_auto('DERIVED/timeline/contract_calls_*.ndjson')
WHERE gas_used > '30000000'
ORDER BY gas_used DESC;

-- ERC20 transfers by token
SELECT asset, count(*) as transfer_count, sum(amount)
FROM read_ndjson_auto('DERIVED/flows/asset_transfers_*.ndjson')
WHERE asset_type = 'erc20'
GROUP BY asset;
```

### With `Pandas` (Python)

```python
import pandas as pd
import glob
import json

# Load all transfer files
dfs = []
for f in glob.glob('DERIVED/flows/asset_transfers_*.ndjson'):
    df = pd.read_json(f, lines=True)
    dfs.append(df)
transfers = pd.concat(dfs)

# ERC20 transfers only
erc20 = transfers[transfers['asset_type'] == 'erc20']

# Top recipients
print(erc20['to'].value_counts().head(10))

# Time series
erc20['timestamp'] = pd.to_datetime(erc20['timestamp'], unit='s')
erc20.set_index('timestamp').resample('1min')['amount'].sum().plot()
```

---

## Performance Tips

1. **Use `jq -s` carefully**: Loads entire file into memory. For large datasets:
   ```bash
   # Instead of:
   # jq -s 'map(select(...))' file
   
   # Use stream processing:
   jq 'select(...)' file
   ```

2. **Filter early**: Always apply `select()` before aggregation
   ```bash
   # Good
   jq 'select(.asset_type == "erc20") | select(.from == "0x...")' file
   
   # Bad
   jq -s 'map(select(...))' file
   ```

3. **Use SQL**: DuckDB is much faster for aggregations
   ```bash
   duckdb -s "SELECT asset, count(*) FROM read_ndjson_auto('...') GROUP BY asset"
   ```

4. **Parallel processing**: Process shard files independently
   ```bash
   for shard in DERIVED/flows/asset_transfers_*.ndjson; do
     (jq '...' "$shard" &)
   done
   wait
   ```

---

## Bundle Validation

```bash
# Check SHA256 hashes
sha256sum -c TEAM_BUNDLE/MANIFEST.sha256

# Verify no spoilers in TEAM_BUNDLE
find TEAM_BUNDLE -name "*.md" | xargs grep -i "attacker" || echo "Clean"

# Check RESEARCH has spoilers
grep "attacker" RESEARCH_BUNDLE/TRUTH/actors.json && echo "Good"

# Row counts
echo "TEAM blocks: $(jq -s 'length' TEAM_BUNDLE/RAW/chain/blocks*.ndjson)"
echo "TEAM profiles: $(jq -s 'length' TEAM_BUNDLE/DERIVED/behavior/address_profile*.ndjson)"
```

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `block_tx_order` missing | No transactions exported | Check `tx_exported_success > 0` in RUN_META.json |
| `revert_reason` is null | Trace unavailable or decode failed | Check if `debug_traceTransaction` supported |
| `internal_native_transfers` empty | No call with value > 0 | Check for DELEGATECALL/STATICCALL (no value) |
| `allowance_usage` empty | No transferFrom detected | Check token transfer logs have correct selector |
| `mempool_pending` empty | Not on Anvil or eth_pendingTransactions failed | Expected on real chains |
| `token_balance_deltas` missing | Token doesn't implement ERC20 | Check for custom implementations |
