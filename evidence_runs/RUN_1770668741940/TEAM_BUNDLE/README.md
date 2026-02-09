# TEAM_BUNDLE (RAW + DERIVED)

**Purpose**: Client-style evidence bundle for forensic investigation.
**Spoiler Level**: NONE - Contains no ground truth / attacker identity.

## Contents

- **RAW/**: Primary on-chain data
  - chain/: blocks, txs, receipts, event logs
  - execution/: call traces (best-effort)
  - state/: ETH balances, storage slots, token balances
  - code/: contract code, ERC20 metadata

- **DERIVED/**: Forensic-ready enrichments
  - timeline/: transaction ordering, contract calls, enriched txs
  - flows/: fund flows (ETH + ERC20), internal transfers
  - behavior/: address profiling, hot methods
  - execution/: call graph edges, revert reasons
  - approvals/: Approvals, allowance edges, usage detection
  - governance/: admin slot changes, critical storage deltas
  - balances/: token balance changes
  - mempool/: (SIM-only, may be empty)

- **ABI/**: Contract ABIs, bytecode, address registry

- **META/**: Metadata and schema definitions

## Investigation Guide

1. Start with DERIVED/timeline/tx_enriched to understand the sequence.
2. Use DERIVED/flows to trace fund movements.
3. Check DERIVED/behavior/address_profile for participant activity.
4. Examine DERIVED/approvals/allowance_usage for token abuse.
5. Look at DERIVED/governance for privilege changes.

## Notes

- Some transactions may revert. See tx_enriched.status and revert_reasons.
- Traces are best-effort; may be missing if node doesn't support debug_traceTransaction.
- Mempool data is SIM-ONLY; don't expect equivalent in real incidents.
