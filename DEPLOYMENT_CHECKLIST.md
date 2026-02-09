# Forensics-Sim v2: Implementation Checklist & Migration Guide

## Pre-Deployment Checklist

### Code Quality
- [x] **No breaking changes**: v2 is backward-compatible with v1
- [x] **All new features have fallbacks**: Graceful degradation if sources unavailable
- [x] **Error handling**: Try/catch for all optional data sources
- [x] **BigInt handling**: All numeric values properly stringified for JSON
- [x] **Set → Array conversion**: address_profile.call_targets properly serialized

### Data Completeness
- [x] **Address profiling**: Captures from/to, logs, traces, calls
- [x] **Block ordering**: receipt.transactionIndex available for all txs
- [x] **Internal transfers**: Recursive trace walking extracts all call values
- [x] **Token metadata**: Wrapped in try/catch, gracefully null if unavailable
- [x] **Approval tracking**: Approval + transferFrom linking implemented

### Directory Structure
- [x] **RAW**: chain/, execution/, state/, code/ subdirs
- [x] **DERIVED**: timeline/, flows/, behavior/, execution/, approvals/, governance/, balances/, mempool/
- [x] **ABI**: abi/, bytecode/ organized
- [x] **META**: versions.json, schema_version.json created

### Documentation
- [x] **UPGRADE_V2_DETAILED.md**: Comprehensive feature documentation
- [x] **FORENSICS_QUERY_GUIDE.md**: Query templates and examples
- [x] **This guide**: Deployment and migration instructions
- [x] **RUN_META.json**: Updated with v2-specific notes

---

## Migration Steps

### Option A: Immediate Switch (Recommended)

```bash
cd ~/Desktop/Projects/forensics-sim

# 1. Backup old version (keep for comparison)
cp scripts/pipeline_all.js scripts/pipeline_all_v1_backup.js

# 2. Deploy new version
cp scripts/pipeline_all_v2.js scripts/pipeline_all.js

# 3. Test on small dataset first
export TOTAL_TX=100
export USER_COUNT=50
export SEED=1337
npx hardhat run scripts/pipeline_all.js

# 4. Validate output structure
ls -la evidence_runs/RUN_*/TEAM_BUNDLE/
ls -la evidence_runs/RUN_*/RESEARCH_BUNDLE/

# 5. If satisfied, run full simulation
export TOTAL_TX=10000
export USER_COUNT=1000
npx hardhat run scripts/pipeline_all.js
```

### Option B: Parallel Testing

```bash
# Keep both versions during evaluation period
cp scripts/pipeline_all.js scripts/pipeline_all_v1_prod.js
cp scripts/pipeline_all_v2.js scripts/pipeline_all.js

# Test v2
TOTAL_TX=100 npx hardhat run scripts/pipeline_all.js
mv evidence_runs/RUN_*/ evidence_runs/v2_test/

# Revert to v1 temporarily
cp scripts/pipeline_all_v1_prod.js scripts/pipeline_all.js
TOTAL_TX=100 npx hardhat run scripts/pipeline_all.js
mv evidence_runs/RUN_*/ evidence_runs/v1_test/

# Compare outputs
diff -r evidence_runs/v1_test/TEAM_BUNDLE evidence_runs/v2_test/TEAM_BUNDLE
```

---

## Validation Tests

### 1. Directory Structure Validation

```bash
#!/bin/bash
# run_validation.sh

BUNDLE_PATH="${1:-TEAM_BUNDLE}"

echo "Checking directory structure..."

required_dirs=(
  "RAW/chain"
  "RAW/execution"
  "RAW/state"
  "RAW/code"
  "DERIVED/timeline"
  "DERIVED/flows"
  "DERIVED/behavior"
  "DERIVED/execution"
  "DERIVED/approvals"
  "DERIVED/governance"
  "DERIVED/balances"
  "DERIVED/mempool"
  "ABI"
  "META"
)

for dir in "${required_dirs[@]}"; do
  if [ -d "$BUNDLE_PATH/$dir" ]; then
    echo "✓ $dir"
  else
    echo "✗ MISSING: $dir"
  fi
done

echo ""
echo "Checking files..."
find "$BUNDLE_PATH" -type f -name "*.ndjson" | sort | head -20
```

### 2. Data Completeness Check

```bash
#!/bin/bash
# check_data.sh

count_docs() {
  local pattern=$1
  find TEAM_BUNDLE -name "$pattern" -type f | xargs wc -l | tail -1 | awk '{print $1}'
}

echo "Document type counts:"
echo "blocks:        $(count_docs 'blocks*.ndjson')"
echo "txs:           $(count_docs 'txs*.ndjson')"
echo "receipts:      $(count_docs 'receipts*.ndjson')"
echo "block_tx_order: $(count_docs 'block_tx_order*.ndjson')"
echo "tx_enriched:   $(count_docs 'tx_enriched*.ndjson')"
echo "asset_transfer: $(count_docs 'asset_transfer*.ndjson')"
echo "address_profile: $(count_docs 'address_profile*.ndjson')"
echo "allowance_usage: $(count_docs 'allowance_usage*.ndjson')"
echo "mempool_pending: $(count_docs 'mempool_pending*.ndjson')"
```

### 3. No Spoilers Check (TEAM_BUNDLE)

```bash
#!/bin/bash
# check_team_bundle_clean.sh

echo "Checking for spoiler leaks in TEAM_BUNDLE..."

# Should NOT contain attack timeline
if grep -r "attack_events" TEAM_BUNDLE/ 2>/dev/null; then
  echo "✗ FAIL: Attack events found in TEAM_BUNDLE"
  exit 1
fi

# Should NOT contain ground truth
if grep -r "attacker" TEAM_BUNDLE/DERIVED TEAM_BUNDLE/RAW 2>/dev/null; then
  echo "✗ FAIL: Attacker identities found in TEAM_BUNDLE"
  exit 1
fi

# Should have README without spoilers
if grep -r "ground truth\|solution\|exploit" TEAM_BUNDLE/README.md 2>/dev/null; then
  echo "✗ FAIL: Spoilers in TEAM_BUNDLE README"
  exit 1
fi

echo "✓ TEAM_BUNDLE is clean (no spoilers detected)"
```

### 4. RESEARCH_BUNDLE Completeness Check

```bash
#!/bin/bash
# check_research_bundle.sh

echo "Checking RESEARCH_BUNDLE completeness..."

required_files=(
  "TRUTH/actors.json"
  "TRUTH/attack_plan.json"
  "DECODED/timeline.md"
  "RUN_META.json"
  "MANIFEST.sha256"
)

for file in "${required_files[@]}"; do
  if [ -f "RESEARCH_BUNDLE/$file" ]; then
    echo "✓ $file"
  else
    echo "✗ MISSING: $file"
  fi
done
```

### 5. Data Integrity Check

```bash
#!/bin/bash
# check_integrity.sh

echo "Verifying SHA256 hashes..."

# Check TEAM_BUNDLE
if sha256sum -c TEAM_BUNDLE/MANIFEST.sha256 > /tmp/team_check.log 2>&1; then
  echo "✓ TEAM_BUNDLE integrity verified"
else
  echo "✗ TEAM_BUNDLE integrity check failed:"
  head -20 /tmp/team_check.log
fi

# Check RESEARCH_BUNDLE
if sha256sum -c RESEARCH_BUNDLE/MANIFEST.sha256 > /tmp/research_check.log 2>&1; then
  echo "✓ RESEARCH_BUNDLE integrity verified"
else
  echo "✗ RESEARCH_BUNDLE integrity check failed:"
  head -20 /tmp/research_check.log
fi
```

### 6. Row Count Consistency

```javascript
// validate.js - Run with: node validate.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function countLines(filePath) {
  return new Promise((resolve, reject) => {
    let lineCount = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });
    rl.on('line', () => lineCount++);
    rl.on('close', () => resolve(lineCount));
    rl.on('error', reject);
  });
}

async function validateBundle(bundlePath) {
  console.log(`Validating ${bundlePath}...`);
  
  const files = fs.readdirSync(bundlePath, { recursive: true })
    .filter(f => f.endsWith('.ndjson'));
  
  const counts = {};
  for (const file of files) {
    const fullPath = path.join(bundlePath, file);
    const count = await countLines(fullPath);
    const docType = extractDocType(file);
    counts[docType] = (counts[docType] || 0) + count;
  }
  
  console.log("\nDocument counts:");
  for (const [type, count] of Object.entries(counts).sort()) {
    console.log(`  ${type}: ${count}`);
  }
  
  // Consistency checks
  const { 'block_tx_order': orderCount = 0, 'tx_enriched': txCount = 0 } = counts;
  if (orderCount > 0 && txCount > 0 && orderCount !== txCount) {
    console.warn(`⚠ Mismatch: block_tx_order (${orderCount}) != tx_enriched (${txCount})`);
  }
}

function extractDocType(filename) {
  const match = filename.match(/([a-z_]+)_\d+\.ndjson/);
  return match ? match[1] : filename;
}

validateBundle('TEAM_BUNDLE');
validateBundle('RESEARCH_BUNDLE');
```

---

## Performance Benchmarks

### Expected Performance (10k txs, 1k users)

| Phase | Time | Memory | Notes |
|-------|------|--------|-------|
| Simulation | 5-15 min | 200MB | Depends on network latency |
| RAW export | 10-20 min | 300MB | Trace fetching is I/O bound |
| Token snapshots | 2-5 min | 150MB | ERC20 balanceOf calls |
| DERIVED generation | 5-10 min | 200MB | Address profiling, aggregations |
| Bundling | 1-2 min | 100MB | Copying files |
| **Total** | **25-55 min** | **Peak: 300MB** | Full pipeline |

### Optimization Tips

1. **Reduce checkpoints** (if disk space is critical):
   ```bash
   CHECKPOINT_EVERY=1000 npx hardhat run scripts/pipeline_all.js
   ```

2. **Reduce snapshot cap** (if user profiling not needed):
   ```bash
   SNAPSHOT_USER_CAP=30 npx hardhat run scripts/pipeline_all.js
   ```

3. **Reduce total txs** (for testing):
   ```bash
   TOTAL_TX=1000 npx hardhat run scripts/pipeline_all.js
   ```

4. **Parallel trace fetching** (advanced):
   - Modify pipeline to fetch traces in parallel batches
   - Current: sequential (safe, stable)
   - Could improve by 2-3x with proper async management

---

## Troubleshooting

### Issue: `block_tx_order` file is empty

**Cause**: No transactions were exported

**Check**:
```bash
jq '.tx_exported_success' TEAM_BUNDLE/RUN_META.json
```

**Fix**: Ensure Anvil is running and simulation completes successfully

---

### Issue: `internal_native_transfers` has very few rows

**Cause**: Most contracts use STATICCALL or DELEGATECALL (no value transfer)

**This is expected**. Only external calls with `value > 0` are captured.

---

### Issue: `allowance_usage` is empty

**Causes**:
1. No ERC20 transfers detected (check `asset_transfers`)
2. transferFrom selector not recognized

**Check**:
```bash
# Check if there are any ERC20 transfers
jq 'select(.asset_type == "erc20")' DERIVED/flows/asset_transfers_*.ndjson | head

# Check if transferFrom is in encoded calls
jq 'select(.method_id == "0x23b872dd")' DERIVED/timeline/contract_calls_*.ndjson | head
```

---

### Issue: `mempool_pending` is empty or missing

**This is normal**. The pipeline handles failures gracefully:
- On real chains: eth_pendingTransactions is not historical
- On Anvil: mempool may be empty if automine is enabled

**No action required**. This is simulation-specific.

---

### Issue: `revert_reasons` mostly shows `null`

**Cause**: debug_traceTransaction not supported on your node

**Check**:
```bash
# Test if tracer is available
curl -s http://localhost:8545 -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"debug_traceTransaction","params":["0x...","{}"],"id":1}' \
  | jq '.error'
```

**If error**: This is normal on some nodes. The pipeline handles it gracefully.

---

## Rollback Plan

If issues arise:

```bash
# 1. Revert to v1 temporarily
cp scripts/pipeline_all_v1_backup.js scripts/pipeline_all.js

# 2. Remove problematic v2 outputs
rm -rf evidence_runs/RUN_*_v2/

# 3. Re-run with v1
npx hardhat run scripts/pipeline_all.js

# 4. Investigate v2 issues
# Review logs, check Anvil status, etc.
```

---

## Success Criteria

A successful v2 deployment demonstrates:

✓ **All new files present**:
- `DERIVED/timeline/block_tx_order_*.ndjson`
- `DERIVED/flows/internal_native_transfers_*.ndjson`
- `DERIVED/approvals/allowance_usage_*.ndjson`
- `META/versions.json` and `META/schema_version.json`

✓ **Data quality**:
- `address_profile` includes all participants
- `block_tx_order` rows = `tx_enriched` rows
- No null values in critical fields

✓ **Bundle separation**:
- `TEAM_BUNDLE` contains no spoilers
- `RESEARCH_BUNDLE` contains TRUTH and DECODED

✓ **Performance**:
- 10k tx simulation completes in < 60 min
- Peak memory < 500MB
- Manifest hashes verify correctly

✓ **Documentation**:
- README.md explains structure
- Query examples work against actual data
- RUN_META.json captures all relevant metadata

---

## Post-Deployment

### 1. Notify Team
```
Subject: Forensics-Sim v2 Deployed
Body:
- New features: block ordering, allowance tracking, governance monitoring
- Query guide: /FORENSICS_QUERY_GUIDE.md
- No breaking changes; backward compatible
- See UPGRADE_V2_DETAILED.md for complete details
```

### 2. Update CI/CD
- Update pipeline runner to use new version
- Update validation scripts
- Store both bundles (TEAM + RESEARCH)

### 3. Archive Previous Runs
```bash
# Keep v1 outputs for comparison
tar czf evidence_runs_v1_archive.tar.gz evidence_runs/*/TEAM_BUNDLE
```

### 4. Monitor for Issues
```bash
# Weekly sanity check
TOTAL_TX=100 USER_COUNT=50 npx hardhat run scripts/pipeline_all.js
# Validate output structure
sh check_data.sh
```

---

## Success Log Template

```
# v2 Deployment Log

Date: 2026-02-XX
Deployed by: [Name]
Environment: [Dev/Staging/Prod]

## Pre-Deployment
- [ ] Code review complete
- [ ] All tests pass
- [ ] Documentation complete
- [ ] Team notified

## Deployment
- [ ] Backup v1 script
- [ ] Deploy v2 script
- [ ] Run test simulation
- [ ] Validate output structure
- [ ] Check data integrity
- [ ] Verify no spoilers in TEAM_BUNDLE

## Post-Deployment
- [ ] Monitor for errors
- [ ] Document any issues
- [ ] Update runbooks
- [ ] Notify data consumers

## Test Results
- Simulation time: XX min
- Peak memory: XX MB
- Total files: XX
- Hash verification: PASS

## Issues Encountered
[None / List any]

## Sign-off
[Name, Date]
```

---

## Quick Reference Commands

```bash
# Deploy
cp scripts/pipeline_all_v2.js scripts/pipeline_all.js

# Test
TOTAL_TX=100 USER_COUNT=50 npx hardhat run scripts/pipeline_all.js

# Validate
sh check_team_bundle_clean.sh
sha256sum -c TEAM_BUNDLE/MANIFEST.sha256

# Query
jq '.' TEAM_BUNDLE/DERIVED/timeline/block_tx_order_*.ndjson
jq 'select(.used_amount)' TEAM_BUNDLE/DERIVED/approvals/allowance_usage_*.ndjson

# Archive
tar czf forensics_run_$(date +%s).tar.gz TEAM_BUNDLE RESEARCH_BUNDLE

# Cleanup
rm -rf evidence_runs/RUN_*/RAW evidence_runs/RUN_*/DERIVED evidence_runs/RUN_*/ABI evidence_runs/RUN_*/META
```

---

**Questions?** Check UPGRADE_V2_DETAILED.md or FORENSICS_QUERY_GUIDE.md
