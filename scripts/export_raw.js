const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeNDJSON(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj, (k,v)=> typeof v==="bigint"?v.toString():v) + "\n");
}

async function main() {
  const runId = `RUN_${Date.now()}`;
  const out = path.join("evidence_runs", runId, "RAW");
  ensureDir(out);

  const sim = JSON.parse(fs.readFileSync("sim_output.json", "utf8"));
  const txHashes = sim.txHashes;

  console.log("Exporting RAW logs for", txHashes.length, "transactions");

  const seenBlocks = new Set();

  for (let i = 0; i < txHashes.length; i++) {
    const h = txHashes[i];

    const tx = await ethers.provider.getTransaction(h);
    const rc = await ethers.provider.getTransactionReceipt(h);
    const block = await ethers.provider.getBlock(rc.blockHash);

    writeNDJSON(path.join(out, "txs.ndjson"), tx);
    writeNDJSON(path.join(out, "receipts.ndjson"), rc);

    if (!seenBlocks.has(block.hash)) {
      seenBlocks.add(block.hash);
      writeNDJSON(path.join(out, "blocks.ndjson"), block);
    }

    for (const log of rc.logs) {
      writeNDJSON(path.join(out, "logs_events.ndjson"), log);
    }

    // Call trace (Anvil supports this)
    try {
      const trace = await ethers.provider.send(
        "debug_traceTransaction",
        [h, { tracer: "callTracer" }]
      );
      writeNDJSON(path.join(out, "traces_call.ndjson"), {
        txHash: h,
        trace
      });
    } catch (e) {
      // Safe fallback
    }

    if ((i + 1) % 500 === 0) {
      console.log(`RAW exported ${i + 1}/${txHashes.length}`);
    }
  }

  console.log("RAW export complete:", out);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
