# Forensics Pipeline: Problem Diagnosis

## Summary
The current pipeline exhibits gaps in coverage and incomplete state reconstruction, characteristic of best-effort local simulation tracing. This document explains root causes and justifies the fixes.

---

## Problem 1: address_profile produces only 1 record (nearly empty)

### Root Cause
The address profiling logic only updates metrics when:
1. **ETH transfers occur**: `if (tx.value > 0n)` → updates `eth_in_wei`, `eth_out_wei`, `eth_in_txs`, `eth_out_txs`
2. **ERC20 Transfer events are logged**: parses `Transfer(address, address, uint256)` logs → updates `erc20_in/erc20_out`

### Why This Fails
- **Contract calls with value=0**: The majority of attack txs involve value=0 (e.g., swaps, approvals, reentrancy calls)
- **No Transfer events**: Transactions that interact with contracts but produce no token transfers remain invisible (e.g., view calls, failed trades, permission checks)
- **Result**: Only ~1 active address gets profiled (likely the deployer who sent ETH to others)

### Fix Applied
Expand profiling to capture **ALL transaction activity**:
- `tx_out_count`: count of txs where address is `from`
- `tx_in_count`: count of txs where address is `to`
- `gas_spent_wei`: `receipt.gasUsed * receipt.effectiveGasPrice` (with fallback to `tx.gasPrice`)
- `total_gas_used`: cumulative gas consumed
- `first_seen_ts` / `last_seen_ts`: temporal window
- **Preserve existing** ETH/ERC20 tracking

This ensures every participant in the chain is profileable, even if they only executed contract calls.

---

## Problem 2: state_diff is prestate-only with hex balances

### Root Cause
The Anvil node (and many debug implementations) only support `prestateTracer`, which returns **pre-state only**:
- `balance_before`: provided as hex
- `balance_after`: **null** (not computed)
- `storage_after`: **null** (not computed)

The current code treats prestate as a complete diff, which is misleading.

### Why This Matters
- Researchers may assume `balance_after=null` means "unchanged" when in fact the state was modified but not captured
- Hex format is inconsistent with other numeric fields (which use decimal strings)
- No indication of the tracer limitation in the data itself

### Fix Applied
- Add `mode: "prestate_only"` field to signal the limitation
- Normalize balances from hex to decimal strings for consistency
- Document in RUN_META.json that this is best-effort capture, not a true state diff
- Do NOT attempt to brute-force post-state computation (performance concern)

---

## Problem 3: ABI export missing runtime bytecode

### Root Cause
Current code uses:
```javascript
artifact.bytecode  // Creation code (includes constructor)
```

But should prefer:
```javascript
artifact.deployedBytecode  // Runtime code (actual contract bytecode on-chain)
```

Also relies on hardcoded artifact paths instead of Hardhat's API.

### Why This Matters
- Bytecode matching (detection of redeployed contracts, proxy verification) requires **runtime bytecode**
- Hardcoded paths are brittle and fail on layout changes
- `hre.artifacts.readArtifact()` is the official API

### Fix Applied
- Use `hre.artifacts.readArtifact(contractName)` to load artifacts reliably
- Prefer `artifact.deployedBytecode`; fallback to `artifact.bytecode` if not available
- Write to `ABI/bytecode/<Contract>.bin` (runtime code)
- Copy ABI directories into both TEAM_BUNDLE and RESEARCH_BUNDLE

---

## Problem 4: Missing derived logs (contract calls, method stats, trace edges, revert reasons)

### Root Cause
Current derived outputs only capture:
- `tx_enriched`: basic tx metadata
- `asset_transfers`: ERC20 Transfer + ETH events only
- `fund_flow_edges`: payment graph only
- `approvals` / `allowance_edges`: approval events only

Missing: **contract interaction patterns, call graphs, and error signals**.

### Why This Matters
For forensics:
- **Detecting patterns**: repeated calls to same method reveal potential attack preparation
- **Call graphs**: tracing execution flow between contracts (reentrancy, flash loans, cascading calls)
- **Error detection**: revert reasons help identify failed exploit attempts and privilege checks

### Fix Applied
Add four new derived datasets (NO spoilers added):

1. **DERIVED/contract_calls_*.ndjson**
   - One row per tx
   - Fields: `tx_hash`, `from`, `to`, `method_id`, `status`, `value_wei`, `gas_used`, `effective_gas_price`, `timestamp`, `block_number`
   - Enables pattern detection without revealing intended behavior

2. **DERIVED/method_stats_*.ndjson**
   - Aggregated stats per `(to_address, method_id)` pair
   - Fields: `to`, `method_id`, `count`, `success_count`, `revert_count`, `unique_callers`, `first_seen_ts`, `last_seen_ts`
   - Identifies hot methods and their success rates

3. **DERIVED/trace_edges_*.ndjson** (from callTracer)
   - Each call between contracts
   - Fields: `caller`, `callee`, `call_type`, `value`, `input_selector`, `depth`, `tx_hash`, `block_number`, `timestamp`
   - Reconstructs call graphs for execution flow analysis

4. **DERIVED/revert_reasons_*.ndjson** (best-effort)
   - For reverted txs, extract error reason from trace output
   - Fields: `tx_hash`, `status`, `reason`, `timestamp`, `block_number`
   - Gracefully handles missing trace output (null reason)

---

## Problem 5: Mempool handling

### Root Cause
No mention of mempool in the current pipeline. In reality:
- **Mempool is ephemeral**: not stored on-chain, not queryable historically
- **Real incidents**: forensics agents often cannot access mempool (it's not chain state)
- **Local Anvil**: can capture pending txs in simulation, but only during execution

### Why This Matters
Mempool analysis (transaction ordering, front-running timing) is valuable but unreliable in real incidents.

### Fix Applied
- Document in RUN_META.json: mempool is simulation artifact, may not be available on real nodes
- Add optional DERIVED/mempool_pending_*.ndjson (best-effort, local Anvil only)
- If unsupported, create empty file with note
- Researchers must understand this is sim-specific, not generalizable

---

## Constraints Honored
✅ No removal or renaming of existing files/fields  
✅ TEAM_BUNDLE remains sanitized (no attacker labels in new fields)  
✅ RESEARCH_BUNDLE TRUTH/DECODED unchanged  
✅ NDJSON sharding behavior preserved  
✅ No brute-force storage scanning  
✅ All tracing is best-effort with graceful fallback  

---

## Summary of Deliverables
1. **Updated pipeline_all.js** with all fixes and new derived outputs
2. **Updated RUN_META.json notes** documenting new logs and limitations
3. **This diagnosis** explaining rationale for each change
