TEAM_BUNDLE (RAW + DERIVED)

Purpose:
- Client-style evidence bundle for forensic investigation.
- Contains no ground truth / attacker identity.

Contents:
- RAW: blocks, txs, receipts, event logs, best-effort call traces, balance snapshots.
- DERIVED: neutral enrichments + transfer lists + flow edges + address profiles.

Notes:
- Some transactions may revert (realistic). See receipts.status and DERIVED.tx_enriched.status.
