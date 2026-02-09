# Forensics-Sim — Project Documentation

## Overview
forensics-sim is a reproducible Ethereum simulation and evidence-bundling tool. It runs a Hardhat-based local chain, deploys test contracts, simulates normal and adversarial transactions, exports raw blockchain data and derived enrichments, and packages the outputs into investigator-friendly bundles (TEAM_BUNDLE and RESEARCH_BUNDLE).

## Purpose
- Generate synthetic forensic datasets for training, analysis, and tooling development.
- Produce two bundle formats:
  - TEAM_BUNDLE: sanitized investigator bundle without ground-truth labels
  - RESEARCH_BUNDLE: full bundle including TRUTH and decoded timeline for validation and research

## Requirements
- Node.js (>=16)
- npm / yarn
- Hardhat (project already configured)
- OS: Tested on Linux/Windows/macOS

## Installation
1. Install dependencies:

```bash
npm install
# or
# yarn
```

## Key Scripts
- `./run_pipeline.sh` — Top-level helper that runs the pipeline (invokes `scripts/pipeline_all.js` via Hardhat node/run).
- `node scripts/pipeline_all.js` — Main pipeline script that runs the simulation and exports bundles.
- `scripts/simulate_10k.js` — helper simulation script (if present).
- `scripts/export_raw.js` — utilities used by the pipeline.

## Pipeline Stages (high-level)
1. Simulation: deploy contracts and execute a mix of normal and attack transactions.
2. Raw export: write `RAW` NDJSON files (blocks, txs, receipts, logs, traces, snapshots, codes, token metadata, storage snapshots).
3. Derived export: compute `DERIVED` NDJSON (tx_enriched, asset_transfers, fund_flow_edges, address_profile, etc.).
4. ABI export: extract ABIs, bytecode, and `addresses.json` for the run into `ABI/`.
5. Bundling: copy RAW, DERIVED, ABI, and metadata into `TEAM_BUNDLE` and `RESEARCH_BUNDLE`.
6. Hashing: produce `hashes.sha256` inside each bundle to enable integrity verification.
7. Cleanup: (configurable) remove intermediate root folders to keep the run folder tidy.

## Output Structure (per run)
Each run creates a folder under `evidence_runs/` named `RUN_<timestamp>/` with the following important artifacts:
- `RAW/` — raw NDJSON files (see Evidence Bundle doc for full breakdown)
- `DERIVED/` — derived NDJSON enrichments
- `ABI/` — `abi/` directory with per-contract ABI JSONs, `bytecode/` with .bin, and `addresses.json`
- `TEAM_BUNDLE/` — copied RAW + DERIVED + ABI + RUN_META.json + hashes.sha256 intended for investigators
- `RESEARCH_BUNDLE/` — same as TEAM_BUNDLE but includes `TRUTH/` and `DECODED/` with ground-truth and timeline
- `RUN_META.json` — run-level metadata
- `sim_output_full` / `sim_output.json` — full simulation summary

## Configuration
Environment variables supported by the pipeline (defaults shown in code):
- `TOTAL_TX` (10000)
- `USER_COUNT` (1000)
- `SEED` (1337)
- `SHARD_SIZE` (5000)
- `CHECKPOINT_EVERY` (500)
- `SNAPSHOT_USER_CAP` (120)

Adjust these by prefixing the run command, e.g.:

```bash
TOTAL_TX=2000 USER_COUNT=200 node scripts/pipeline_all.js
```

## Integrity and Reproducibility
- Each bundle contains a `hashes.sha256` file listing SHA256 hashes of all files in the bundle. Use this to verify integrity before sharing.
- `RUN_META.json` contains run parameters and counts to aid reproducibility.

## Recommended Workflow
1. Run the pipeline to produce a run folder.
2. Verify `hashes.sha256` inside the chosen bundle.
3. Share `TEAM_BUNDLE` with analysts; retain `RESEARCH_BUNDLE` for validation and training.

## Next Steps / Customization
- Add additional derived enrichers (e.g., heuristics for suspicious flow detection).
- Export to Parquet/CSV if downstream tools need columnar data.
- Hook exporter into CI to generate sample datasets.


---

*Files added: `ABI/`, `RAW/`, `DERIVED/`, `TEAM_BUNDLE/`, `RESEARCH_BUNDLE/`, `RUN_META.json` per-run.*
