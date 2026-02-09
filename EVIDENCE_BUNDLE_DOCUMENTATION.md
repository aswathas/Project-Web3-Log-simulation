# Evidence Bundle Documentation — Detailed Breakdown

This document explains the structure, file types, and meaning of contents inside a generated evidence bundle (TEAM_BUNDLE and RESEARCH_BUNDLE).

## High-level
Each bundle is a self-contained folder that contains:
- `RAW/` — low-level blockchain exports (NDJSON shards)
- `DERIVED/` — neutral enrichments and analytic artifacts derived from RAW
- `ABI/` — contract ABIs, bytecode, and `addresses.json` mapping
- `RUN_META.json` — run metadata (parameters, counts, notes)
- `hashes.sha256` — integrity hashes for bundle files
- `README.md` — short guidance for the bundle

The `RESEARCH_BUNDLE` additionally includes:
- `TRUTH/` — attacker identities, contract roles
- `DECODED/` — timeline.md and decoded artifacts for training/validation

## RAW folder — files and meaning
RAW files are NDJSON shards named `<type>_NNNNN.ndjson`. Each line is a JSON object.

Common RAW types:
- `blocks_*` — exported block objects (block number, timestamp, miner, difficulty, parent, transactions array)
- `txs_*` — transaction objects (hash, from, to, value, input data, gas, gasPrice/fee fields)
- `receipts_*` — transaction receipts (status, gasUsed, contractAddress, logs array)
- `logs_events_*` — raw event logs with `address`, `topics`, `data`, `logIndex`
- `traces_call_*` — best-effort call traces from `debug_traceTransaction` (may be absent if node doesn't support)
- `snapshots_balances_*` — balance snapshots for monitored addresses at block heights
- `codes_*` — `eth_getCode` results for contract addresses
- `token_meta_*` — ERC20 metadata collected (name, symbol, decimals)
- `storage_snapshots_*` — targeted storage slot reads for key contracts

Usage:
- RAW is the canonical source to reconstruct the chain activity produced by this simulation.
- Use `txs` + `receipts` + `logs` to match transactions with their outcomes and emitted events.
- `traces_call` can show internal calls and reentrancy behavior when available.

## DERIVED folder — files and meaning
Derived files are NDJSON shards produced by post-processing the RAW data to make analysis easier.

Common DERIVED types:
- `tx_enriched_*` — enriched transaction records, including resolved function signatures, to/from role hints, status, and basic decode
- `asset_transfers_*` — extracted token transfer events normalized as `asset_transfer` objects (asset contract, from, to, amount, tx_hash, block_number, timestamp)
- `fund_flow_edges_*` — edges suitable for graph analysis representing movement of value between addresses
- `address_profile_*` — aggregates per-address (erc20_in, erc20_out, total_tx_count, balance snapshots, tags if any)

Usage:
- DERIVED is the investigator-friendly view to quickly identify suspicious flows, high-degree nodes, and token movements.
- `fund_flow_edges` enables graph approaches (Neo4j, NetworkX) to identify clusters and likely attackers.

## ABI folder — files and meaning
The `ABI/` directory contains:
- `abi/` — per-contract `<ContractName>.json` files containing ABI arrays
- `bytecode/` — per-contract `<ContractName>.bin` files with bytecode (hex, no 0x)
- `addresses.json` — mapping of named contract roles to addresses and a run-level summary

Usage:
- Use ABIs to decode `input` data in transactions, or to re-construct contract calls for analysis.
- `addresses.json` provides the canonical contract addresses deployed in this run.

## RUN_META.json — fields explained
`RUN_META.json` is a JSON summary with fields like:
- `run_id` — string RUN_<timestamp>
- `chain_id` — numeric chain id used by the Hardhat network
- `created_at` — ISO timestamp when run finished
- `head_block_start` / `head_block_end` — block range used
- `total_tx_requested` — configured `TOTAL_TX`
- `user_count` — configured `USER_COUNT`
- `shard_size`, `checkpoint_every`, `snapshot_user_cap` — pipeline params
- `tx_exported_success` — number of exported tx hashes
- `failures_count` — count of recorded failures during simulation
- `notes` — freeform notes about the run and exporter caveats

This file allows quick introspection and reproducibility.

## hashes.sha256 — verification
- Each bundle contains `hashes.sha256` created by hashing all files recursively in the bundle.
- To verify, compute SHA256 for each file and compare against the list. Example (Linux/macOS):

```bash
sha256sum -c hashes.sha256
```

On Windows use appropriate tools (e.g., `Get-FileHash` in PowerShell) or copy the bundle to a Linux environment.

## README.md (bundle-level)
- `TEAM_BUNDLE/README.md` is a short, non-spoiler description of contents and usage for analysts.
- `RESEARCH_BUNDLE/README.md` explains the extra TRUTH and DECODED content.

## Best Practices for Analysts
- Always verify `hashes.sha256` before analysis to ensure bundle integrity.
- Load NDJSON files with streaming tools (e.g., `jq -c`, `ndjson-cli`) rather than trying to parse huge JSON blobs.
- Use `DERIVED/` outputs for triage; refer back to `RAW/` for forensic validation.
- Use `ABI/` to decode transactions and generate human-readable timelines.

## Typical Analysis Workflow
1. Inspect `RUN_META.json` to understand run params.
2. Use `DERIVED/address_profile_*` to find high-activity addresses.
3. Trace suspicious flows in `DERIVED/fund_flow_edges_*` and validate in `RAW/txs_*` and `RAW/receipts_*`.
4. Use `ABI/` to decode inputs and determine which contracts/functions were invoked.
5. For training, use `RESEARCH_BUNDLE/TRUTH/` to validate detection algorithms.

## Tools & Commands (examples)
- Count total exported txs:

```bash
cat DERIVED/tx_enriched_*.ndjson | wc -l
```

- Filter ERC20 transfers for an address:

```bash
jq -c 'select(.doc_type=="asset_transfer" and (.from=="0x..." or .to=="0x..."))' DERIVED/asset_transfers_*.ndjson
```

- Decode a transaction input (Node.js + `ethers` + ABI): use `ABI/abi/<Contract>.json` with `ethers.Interface`.

## Notes & Caveats
- `traces_call` is best-effort using `debug_traceTransaction` and is optional depending on the node capabilities.
- Some transactions intentionally revert to make scenarios realistic — check `receipts_*` status field.
- The pipeline aims to be deterministic when `SEED` is fixed, but environmental differences (node versions) may affect low-level traces.


---

If you want, I can also:
- Add example analysis scripts to the repo that load these NDJSON files and produce summary CSVs.
- Add a short quickstart in `README.md` that links to these docs.
