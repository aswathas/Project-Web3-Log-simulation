# Forensics Simulator - Setup & Usage Guide

A comprehensive blockchain forensics simulation framework that generates realistic evidence bundles for security research and investigation training. Deploys multiple smart contracts with intentional vulnerabilities, simulates attacks, and exports forensic artifacts in production-ready formats.

## Overview

**forensics-sim** is a Hardhat-based project that:

1. **Deploys vulnerable smart contracts** (ERC20 tokens, AMM, vault, etc.)
2. **Simulates complex attack vectors** (reentrancy, access control, sandwich attacks, price manipulation)
3. **Generates blockchain evidence** (transactions, logs, balances, code snapshots)
4. **Exports forensic artifacts** in structured formats:
   - RAW data (blocks, transactions, receipts, traces, balances, contract code, storage)
   - DERIVED data (enriched transactions, token transfers, fund flows, address profiles)
   - ABI metadata (contract interfaces, bytecode, address mappings)
5. **Bundles for different audiences**:
   - **TEAM_BUNDLE**: Evidence-only (no spoilers) → for investigation training
   - **RESEARCH_BUNDLE**: Includes truth data → for validation and research

## Prerequisites

- **Node.js** ≥ 18.x
- **npm** or **yarn**
- **Anvil** (Foundry) or **hardhat node** for local chain simulation

## Installation

### 1. Clone/Navigate to Project

```bash
cd forensics-sim
```

### 2. Install Dependencies

```bash
npm install
```

This installs:
- Hardhat + toolbox
- OpenZeppelin contracts (for ERC20, standard interfaces)
- ethers.js (via hardhat-toolbox)

### 3. Verify Installation

```bash
npx hardhat --version
```

Should output: `Hardhat 2.28.4` (or similar)

## Running the Simulation

### Step 1: Start Local Blockchain (Anvil)

Open a terminal and start Anvil with enough accounts:

```bash
anvil --accounts 1100 --fork-block-number 1 --chain-id 31337
```

**Why 1100 accounts?** The sim uses 1000 user accounts + 5 attacker/deployer accounts. Adjust `--accounts` if you change `USER_COUNT`.

**Output** (on success):
```
Listening on 127.0.0.1:8545
Account #0: 0x1234... (1000 ETH)
Account #1: 0x5678... (1000 ETH)
...
Mnemonic: test test test test test test test test test test test junk
```

**Keep this terminal running!** The chain stays alive for the duration of the simulation.

### Step 2: Run Simulation Pipeline

In a **new terminal**, run:

```bash
npx hardhat run scripts/pipeline_all.js --network localhost
```

**What happens:**
1. Deploys contracts (TestToken, VulnerableVault, SimpleAMM, etc.)
2. Funds users and sets up initial state
3. Simulates 10,000 transactions (5 coordinated attacks + normal activity)
4. Exports blockchain evidence
5. Bundles data into TEAM_BUNDLE and RESEARCH_BUNDLE

**Typical runtime:** 5-15 minutes (depending on machine)

**Console output:**
```
SIM: TOTAL_TX=10000 USER_COUNT=1000 runId=RUN_1707050400123
funded+approved 200/1000
...
SIM done. tx=9847, failures=30
RAW export starting…
RAW: 500/9847
...
DERIVED generation starting…
DERIVED: 500/9847
...
Exporting ABI data…
Bundling…
DONE ✅
Run folder: evidence_runs/RUN_1707050400123
TEAM_BUNDLE: evidence_runs/RUN_1707050400123/TEAM_BUNDLE
RESEARCH_BUNDLE: evidence_runs/RUN_1707050400123/RESEARCH_BUNDLE
```

### Step 3: Explore Output

After the script completes, navigate to the generated run folder:

```bash
ls evidence_runs/RUN_*/
```

You'll see:
- **RUN_META.json** - Metadata about the simulation run
- **sim_output_full.json** - Ground truth (attackers, contracts, attack timeline)
- **TEAM_BUNDLE/** - Evidence for investigators (no spoilers)
- **RESEARCH_BUNDLE/** - Includes ground truth and timeline
- **RAW/** - Raw blockchain data
- **DERIVED/** - Enriched, analyzed data

## Output Structure

### Directory Layout

```
evidence_runs/RUN_1707050400123/
├── RUN_META.json                 # Simulation metadata
├── sim_output_full.json           # Ground truth (attackers, contracts, events)
├── TEAM_BUNDLE/
│   ├── README.md
│   ├── hashes.sha256              # Integrity verification
│   ├── RAW/
│   │   ├── blocks_00000.ndjson    # Block data
│   │   ├── txs_00000.ndjson       # Transaction data
│   │   ├── receipts_00000.ndjson  # Transaction receipts
│   │   ├── logs_events_00000.ndjson
│   │   ├── traces_call_00000.ndjson
│   │   ├── snapshots_balances_00000.ndjson
│   │   ├── codes_00000.ndjson     # eth_getCode for all addresses
│   │   ├── token_meta_00000.ndjson # ERC20 metadata
│   │   └── storage_snapshots_00000.ndjson # Contract storage reads
│   ├── DERIVED/
│   │   ├── tx_enriched_00000.ndjson      # Enhanced tx metadata
│   │   ├── asset_transfers_00000.ndjson  # ERC20 + native transfers
│   │   ├── fund_flow_edges_00000.ndjson  # Value flow graph
│   │   └── address_profile_00000.ndjson  # Address statistics
│   └── ABI/
│       ├── addresses.json         # Contract + attacker addresses
│       ├── abi/
│       │   ├── TestToken.json
│       │   ├── VulnerableVault.json
│       │   ├── SimpleAMM.json
│       │   ├── AdminConfigBug.json
│       │   └── ReentrancyAttacker.json
│       └── bytecode/
│           ├── TestToken.bin
│           ├── VulnerableVault.bin
│           └── ...
├── RESEARCH_BUNDLE/
│   ├── README.md
│   ├── RAW/          # Same as TEAM_BUNDLE
│   ├── DERIVED/      # Same as TEAM_BUNDLE
│   ├── ABI/          # Same as TEAM_BUNDLE
│   ├── TRUTH/
│   │   ├── actors.json        # Attacker identities + contract roles
│   │   └── attack_plan.json   # Attack timeline with tx hashes
│   ├── DECODED/
│   │   └── timeline.md        # Human-readable attack narrative
│   └── hashes.sha256
```

### Data Format: NDJSON

All data is in **NDJSON** (Newline-Delimited JSON):
- One JSON object per line
- Easy to stream/parse line-by-line
- Large datasets split into shards (default: 5000 objects per file)

**Example:**
```ndjson
{"doc_type":"tx","hash":"0xabc...","from":"0x123...","to":"0x456..."}
{"doc_type":"tx","hash":"0xdef...","from":"0x789...","to":"0x012..."}
```

Parse with:
```bash
# Count transactions
wc -l TEAM_BUNDLE/RAW/txs_*.ndjson

# Pretty-print first entry
head -1 TEAM_BUNDLE/RAW/txs_00000.ndjson | jq .

# Extract addresses
jq -r '.from' TEAM_BUNDLE/DERIVED/tx_enriched_*.ndjson | sort | uniq
```

## Environment Variables

Control simulation parameters with env vars:

```bash
TOTAL_TX=5000 SEED=999 npx hardhat run scripts/pipeline_all.js --network localhost
```

| Variable | Default | Description |
|----------|---------|-------------|
| `TOTAL_TX` | 10000 | Total transactions to simulate |
| `USER_COUNT` | 1000 | Number of regular users |
| `SEED` | 1337 | RNG seed (deterministic attacks) |
| `SHARD_SIZE` | 5000 | NDJSON objects per file |
| `CHECKPOINT_EVERY` | 500 | Balance snapshot frequency |
| `SNAPSHOT_USER_CAP` | 120 | Max bounded EOAs to snapshot |

**Example: Quick test run**
```bash
TOTAL_TX=100 USER_COUNT=10 npx hardhat run scripts/pipeline_all.js --network localhost
```

## Understanding the Attacks

The simulation includes **5 attack phases**:

### 1. **Reentrancy** (@ 15% of TOTAL_TX)
- Target: VulnerableVault
- Attacker: Calls `attack()` with recursive callbacks
- Detection: Look for recursive external calls in traces

### 2. **Access Control Bypass** (@ 35% of TOTAL_TX)
- Target: AdminConfigBug contract
- Attacker: Changes treasury and fee parameters without authorization
- Detection: Logs shows unauthorized admin functions called by non-admin

### 3. **Allowance Drain** (@ 55% of TOTAL_TX)
- Target: ERC20 token via victim's approval
- Attacker: Victim approves attacker, then attacker transfers all tokens
- Detection: Two-step pattern in asset_transfers (approve → transferFrom)

### 4. **Sandwich Attack** (@ 75% of TOTAL_TX)
- Target: SimpleAMM
- Attacker: Front-runs user's swap, back-runs to profit
- Detection: Three consecutive high-value swaps by same actor

### 5. **Price Manipulation** (@ 90% of TOTAL_TX)
- Target: SimpleAMM liquidity imbalance
- Attacker: Drains one reserve, then swaps back to profit
- Detection: Large swaps in both directions from single address

## Working with Evidence

### Quick Analysis

**1. Find all attacked contracts:**
```bash
jq -r '.contracts | values[]' data/RUN_xxx/ABI/addresses.json
```

**2. Extract all ERC20 transfers:**
```bash
grep '"asset_type":"erc20"' TEAM_BUNDLE/DERIVED/asset_transfers_*.ndjson | wc -l
```

**3. Find highest-value ETH transfer:**
```bash
jq -r 'select(.asset_type=="native") | .amount_wei | tonumber' \
  TEAM_BUNDLE/DERIVED/asset_transfers_*.ndjson | sort -n | tail -1
```

**4. Identify suspicious addresses:**
```bash
jq -r 'select(.status=="revert") | .from' \
  TEAM_BUNDLE/DERIVED/tx_enriched_*.ndjson | sort | uniq -c | sort -rn
```

### Verification (RESEARCH_BUNDLE only)

```bash
# View attacker addresses
jq . RESEARCH_BUNDLE/TRUTH/actors.json

# View attack timeline
jq . RESEARCH_BUNDLE/TRUTH/attack_plan.json

# Read human-readable narrative
cat RESEARCH_BUNDLE/DECODED/timeline.md
```

## Troubleshooting

### `Error: Could not find network localhost`
**Cause:** Hardhat network not configured or not running
**Fix:** Ensure Anvil is running on `127.0.0.1:8545`

### `Error: Not enough accounts`
**Cause:** Anvil started with too few accounts
**Fix:** Restart Anvil with `--accounts 1100` or higher

### `Error: Could not export TestToken: Cannot find module`
**Cause:** Contracts not compiled
**Fix:** Run `npx hardhat compile` first

### `Error: Transaction reverted`
**Cause:** Some transactions fail (expected in realistic sim)
**Check:** `sim_output_full.json` has `failures` array with details

### Slow execution
**Cause:** Large USER_COUNT or TOTAL_TX
**Optimize:**
```bash
TOTAL_TX=1000 USER_COUNT=100 npx hardhat run scripts/pipeline_all.js --network localhost
```

## Advanced Usage

### Custom Attack Scenarios

Edit `scripts/pipeline_all.js`:
- Modify `attackPoints` array to change when attacks trigger
- Add new attack logic in the `TOTAL_TX` loop
- Adjust `truth.attack_events` to track custom attacks

### Rerun with Same Seed

For reproducible runs, use same `SEED`:
```bash
SEED=42 npx hardhat run scripts/pipeline_all.js --network localhost
```

Same seed = same attack sequence, user order, and randomness.

### Export for External Tools

Use NDJSON files directly with:
- **Apache Spark / Pandas** - for big data analysis
- **Blockchain indexers** - as indexed data source
- **JSON databases** - MongoDB import
- **Blockchain explorers** - for visualization

## Project Structure

```
forensics-sim/
├── contracts/           # Smart contracts (vulnerable by design)
│   ├── TestToken.sol    # ERC20 token
│   ├── VulnerableVault.sol
│   ├── SimpleAMM.sol
│   ├── AdminConfigBug.sol
│   └── ReentrancyAttacker.sol
├── scripts/
│   ├── pipeline_all.js  # Main simulation + export engine
│   ├── simulate_10k.js  # Alternative runner
│   ├── export_raw.js    # Evidence export
│   └── pipeline_all.js  # Full pipeline
├── hardhat.config.js    # Hardhat configuration
├── package.json
├── evidence_runs/       # Generated outputs (created during runs)
├── artifacts/           # Compiled contracts (auto-generated)
└── cache/              # Hardhat cache (auto-generated)
```

## Performance Notes

- **10,000 transactions:** ~10 minutes on modern hardware
- **Blockchain state:** ~1GB peak memory
- **Output size:** ~200-300 MB per run (NDJSON + artifacts)
- **Time bottleneck:** Transaction simulation + balance snapshots

To speed up:
- Reduce `USER_COUNT` (less fund transfers)
- Reduce `CHECKPOINT_EVERY` (fewer balance checks)
- Lower `SNAPSHOT_USER_CAP` (fewer addresses tracked)

## Further Reading

- **Hardhat Docs:** https://hardhat.org
- **ethers.js:** https://docs.ethers.org/v6/
- **OpenZeppelin Contracts:** https://docs.openzeppelin.com/contracts/
- **NDJSON Format:** http://ndjson.org/

---

**Questions?** Check `RUN_META.json` for metadata about any run, or inspect raw NDJSON files with `jq`.


to run 

chmod +x run_pipeline.sh
./run_pipeline.sh


or else

TOTAL_TX=10000 USER_COUNT=1000 ./run_pipeline.sh
