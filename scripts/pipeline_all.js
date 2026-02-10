const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { NonceManager } = require("ethers");

// ---------------------------
// Helpers (FS / NDJSON / Hash)
// ---------------------------
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function safeStringify(obj) {
  return JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function sha256File(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function writeText(p, s) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, s);
}

function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, (k,v)=> typeof v==="bigint"?v.toString():v, 2));
}

function copyDir(src, dst) {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function ndjsonWriter(dir, name, shardSize) {
  ensureDir(dir);
  let shard = 0, count = 0, stream = null;
  const files = [];

  function openNew() {
    if (stream) stream.end();
    const fp = path.join(dir, `${name}_${String(shard).padStart(5, "0")}.ndjson`);
    stream = fs.createWriteStream(fp, { flags: "a" });
    files.push(fp);
    shard += 1;
    count = 0;
  }
  openNew();

  return {
    write(obj) {
      if (count >= shardSize) openNew();
      stream.write(safeStringify(obj) + "\n");
      count += 1;
    },
    end() { if (stream) stream.end(); },
    files() { return files.slice(); }
  };
}

// ---------------------------
// Helpers (chain / gas / mining)
// ---------------------------
async function setAutomine(on) {
  await ethers.provider.send("evm_setAutomine", [on]);
}
async function mine() {
  await ethers.provider.send("evm_mine", []);
}

async function txOpts() {
  const fee = await ethers.provider.getFeeData();
  const gp = fee.gasPrice ?? 1n;
  return { gasPrice: gp + 2n };
}

async function safeWait(promise, tag, failures) {
  try {
    const tx = await promise;
    const rc = await tx.wait();
    return { ok: true, hash: rc.hash, rc };
  } catch (e) {
    failures.push({
      tag,
      code: e.code || null,
      short: e.shortMessage || e.message,
      tx: e.transaction
        ? { from: e.transaction.from, to: e.transaction.to, data: e.transaction.data }
        : null,
      at: new Date().toISOString(),
    });
    return { ok: false, hash: null, rc: null };
  }
}

// ---------------------------
// Random generator (deterministic)
// ---------------------------
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function envInt(name, def) {
  const v = process.env[name];
  return v ? parseInt(v, 10) : def;
}

// ---------------------------
// Log decoding helpers (ERC20 Transfer)
// ---------------------------
const TRANSFER_TOPIC0 = ethers.id("Transfer(address,address,uint256)");

function topicToAddress(topic) {
  // topic is 0x + 64 hex chars; last 40 hex is address
  if (!topic || typeof topic !== "string") return null;
  return "0x" + topic.slice(-40);
}
function hexToBigInt(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

// ---------------------------
// Try call tracer (best-effort)
// ---------------------------
async function tryCallTrace(txHash) {
  try {
    return await ethers.provider.send("debug_traceTransaction", [
      txHash,
      { tracer: "callTracer" }
    ]);
  } catch (_) {
    return null;
  }
}

// ---------------------------
// ERC20 Approval event decoding
// ---------------------------
const APPROVAL_TOPIC0 = ethers.id("Approval(address,address,uint256)");

function decodeApprovalEvent(log) {
  // Approval(address owner, address spender, uint256 value)
  // topics[0] = Approval signature
  // topics[1] = owner (indexed)
  // topics[2] = spender (indexed)
  // data = value (amount)
  try {
    if (!log.topics || log.topics.length < 3) return null;
    if ((log.topics[0] || "").toLowerCase() !== APPROVAL_TOPIC0.toLowerCase()) return null;

    const owner = topicToAddress(log.topics[1]);
    const spender = topicToAddress(log.topics[2]);
    const value = hexToBigInt(log.data || "0x");

    return { owner, spender, value };
  } catch (_) {
    return null;
  }
}

// ---------------------------
// Try prestate tracer (state-diff; best-effort)
// ---------------------------
async function tryPrestateTracer(txHash) {
  try {
    // Try prestateTracer first (Geth/Erigon)
    return await ethers.provider.send("debug_traceTransaction", [
      txHash,
      { tracer: "prestateTracer" }
    ]);
  } catch (_1) {
    try {
      // Fallback: try state-diff compatible variant if supported
      return await ethers.provider.send("debug_traceTransaction", [
        txHash,
        { tracer: "stateDiffTracer" }
      ]);
    } catch (_2) {
      // Node does not support state tracing, skip silently
      return null;
    }
  }
}

// Helper: convert prestate tracer output to state-diff documents
// Anvil/most nodes only support prestateTracer, which returns pre-state only
function prestateToStateDiff(prestateOutput, txHash, blockNumber) {
  const diffs = [];
  if (!prestateOutput) return diffs;

  // prestateTracer returns: { <address>: { balance: hex, code: hex, storage: { slot: value } } }
  // Note: balance and storage values are in hex format from the tracer
  
  try {
    for (const [addr, stateInfo] of Object.entries(prestateOutput)) {
      if (!stateInfo || typeof stateInfo !== "object") continue;

      // Normalize balance from hex to decimal string
      let balanceBeforeStr = "0";
      if (stateInfo.balance) {
        try {
          const hexBal = stateInfo.balance;
          balanceBeforeStr = BigInt(hexBal).toString();
        } catch (_) {
          balanceBeforeStr = stateInfo.balance.toString();
        }
      }

      const diff = {
        doc_type: "prediff",
        tx_hash: txHash,
        block_number: blockNumber,
        address: addr,
        mode: "prestate_only",  // Anvil limitation: only pre-state available
        balance_before: balanceBeforeStr,  // normalized to decimal
        balance_after: null,  // not available from prestateTracer
        storage_before: stateInfo.storage || {},  // raw slot: value pairs
        storage_after: null   // not available from prestateTracer
      };

      diffs.push(diff);
    }
  } catch (_) {
    // Malformed response, skip
  }

  return diffs;
}

// ---------------------------
// MAIN PIPELINE
// ---------------------------
async function main() {
  const TOTAL_TX = envInt("TOTAL_TX", 10000);
  const USER_COUNT = envInt("USER_COUNT", 1000);
  const SEED = envInt("SEED", 1337);

  const SHARD_SIZE = envInt("SHARD_SIZE", 5000);
  const CHECKPOINT_EVERY = envInt("CHECKPOINT_EVERY", 500);
  const SNAPSHOT_USER_CAP = envInt("SNAPSHOT_USER_CAP", 120);

  const runId = `RUN_${Date.now()}`;
  const base = path.join("evidence_runs", runId);
  const rawDir = path.join(base, "RAW");
  const derivedDir = path.join(base, "DERIVED");
  ensureDir(rawDir);
  ensureDir(derivedDir);

  const net = await ethers.provider.getNetwork();
  const head0 = await ethers.provider.getBlockNumber();

  // ---------------------------
  // 1) SIMULATE (5 attacks)
  // ---------------------------
  const R = rng(SEED);

  const rawSigners = await hre.ethers.getSigners();
  const signers = rawSigners.map(s => new NonceManager(s));

  if (signers.length < USER_COUNT + 5) {
    throw new Error(
      `Not enough accounts: have ${signers.length}, need at least ${USER_COUNT + 5}. ` +
      `Restart anvil with enough accounts and matching mnemonic in hardhat.config.js`
    );
  }

  const deployer = signers[0];
  const users = signers.slice(1, 1 + USER_COUNT);
  const attacker1 = signers[1 + USER_COUNT];
  const attacker2 = signers[2 + USER_COUNT];

  // Deploy contracts (waitForDeployment to avoid target=null)
  const Token = await ethers.getContractFactory("TestToken");
  const token = await Token.connect(deployer).deploy("TEST", "TST", ethers.parseEther("1000000"), await txOpts());
  await token.waitForDeployment();

  const stable = await Token.connect(deployer).deploy("STABLE", "STB", ethers.parseEther("1000000"), await txOpts());
  await stable.waitForDeployment();

  const Vault = await ethers.getContractFactory("VulnerableVault");
  const vault = await Vault.connect(deployer).deploy(await txOpts());
  await vault.waitForDeployment();

  const Reent = await ethers.getContractFactory("ReentrancyAttacker");
  const reent = await Reent.connect(attacker1).deploy(await vault.getAddress(), await txOpts());
  await reent.waitForDeployment();

  const AdminBug = await ethers.getContractFactory("AdminConfigBug");
  const adminBug = await AdminBug.connect(deployer).deploy(await txOpts());
  await adminBug.waitForDeployment();

  const AMM = await ethers.getContractFactory("SimpleAMM");
  const amm = await AMM.connect(deployer).deploy(await token.getAddress(), await stable.getAddress(), await txOpts());
  await amm.waitForDeployment();

  const banned = new Set([
    await token.getAddress(),
    await stable.getAddress(),
    await vault.getAddress(),
    await reent.getAddress(),
    await amm.getAddress(),
    await adminBug.getAddress(),
  ]);

  // Seed AMM + distribute
  await (await token.connect(deployer).mint(await deployer.getAddress(), ethers.parseEther("200000"), await txOpts())).wait();
  await (await stable.connect(deployer).mint(await deployer.getAddress(), ethers.parseEther("200000"), await txOpts())).wait();

  await (await token.connect(deployer).approve(await amm.getAddress(), ethers.parseEther("100000"), await txOpts())).wait();
  await (await stable.connect(deployer).approve(await amm.getAddress(), ethers.parseEther("100000"), await txOpts())).wait();
  await (await amm.connect(deployer).seed(ethers.parseEther("100000"), ethers.parseEther("100000"), await txOpts())).wait();

  // Fund users (this is heavy for 1000; it’s correct, but slow)
  for (let i = 0; i < users.length; i++) {
    const ua = await users[i].getAddress();
    await (await token.connect(deployer).mint(ua, ethers.parseEther("100"), await txOpts())).wait();
    await (await stable.connect(deployer).mint(ua, ethers.parseEther("100"), await txOpts())).wait();

    await (await token.connect(users[i]).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();
    await (await stable.connect(users[i]).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();

    if ((i + 1) % 200 === 0) console.log(`funded+approved ${i + 1}/${users.length}`);
  }

  // Fund attackers
  await (await token.connect(deployer).mint(await attacker1.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();
  await (await stable.connect(deployer).mint(await attacker1.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();
  await (await token.connect(deployer).mint(await attacker2.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();
  await (await stable.connect(deployer).mint(await attacker2.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();

  await (await token.connect(attacker1).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();
  await (await stable.connect(attacker1).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();

  // Fund vault for reentrancy
  const deposits = Math.min(50, users.length);
  for (let i = 0; i < deposits; i++) {
    await (await vault.connect(users[i]).deposit({ value: ethers.parseEther("0.2"), ...(await txOpts()) })).wait();
  }

  const txHashes = [];
  const failures = [];
  const truth = {
    seed: SEED,
    attackers: [await attacker1.getAddress(), await attacker2.getAddress()],
    contracts: {
      token: await token.getAddress(),
      stable: await stable.getAddress(),
      vault: await vault.getAddress(),
      reent: await reent.getAddress(),
      amm: await amm.getAddress(),
      adminBug: await adminBug.getAddress(),
    },
    attack_events: []
  };

  async function record(res) { if (res.ok && res.hash) txHashes.push(res.hash); }

  async function pickOtherUser(uAddr) {
    let v = users[Math.floor(R() * users.length)];
    let vAddr = await v.getAddress();
    if (vAddr === uAddr) {
      v = users[(Math.floor(R() * users.length) + 1) % users.length];
      vAddr = await v.getAddress();
    }
    if (banned.has(vAddr)) return null;
    return v;
  }

  async function normalTx() {
    const u = users[Math.floor(R() * users.length)];
    const uAddr = await u.getAddress();
    const choice = Math.floor(R() * 3);

    if (choice === 0) {
      const v = await pickOtherUser(uAddr);
      if (!v) return;
      const vAddr = await v.getAddress();
      const res = await safeWait(
        u.sendTransaction({ to: vAddr, value: ethers.parseEther("0.000001"), ...(await txOpts()) }),
        "normal_eth_transfer",
        failures
      );
      await record(res);
    } else if (choice === 1) {
      const res = await safeWait(
        amm.connect(u).swapTokenForStable(ethers.parseEther("0.1"), await txOpts()),
        "normal_swap_token_for_stable",
        failures
      );
      await record(res);
    } else {
      const res = await safeWait(
        amm.connect(u).swapStableForToken(ethers.parseEther("0.1"), await txOpts()),
        "normal_swap_stable_for_token",
        failures
      );
      await record(res);
    }
  }

  const attackPoints = [
    Math.floor(TOTAL_TX * 0.15),
    Math.floor(TOTAL_TX * 0.35),
    Math.floor(TOTAL_TX * 0.55),
    Math.floor(TOTAL_TX * 0.75),
    Math.floor(TOTAL_TX * 0.90),
  ];

  console.log(`SIM: TOTAL_TX=${TOTAL_TX} USER_COUNT=${USER_COUNT} runId=${runId}`);

  for (let i = 1; i <= TOTAL_TX; i++) {
    if (i === attackPoints[0]) {
      const res = await safeWait(
        reent.connect(attacker1).attack(ethers.parseEther("0.05"), { value: ethers.parseEther("0.05"), ...(await txOpts()) }),
        "attack_reentrancy",
        failures
      );
      await record(res);
      truth.attack_events.push({ attack: "reentrancy", at: i, attacker: await attacker1.getAddress(), tx: res.hash });
      continue;
    }

    if (i === attackPoints[1]) {
      const r1 = await safeWait(adminBug.connect(attacker2).setTreasury(await attacker2.getAddress(), await txOpts()), "attack_access_setTreasury", failures);
      const r2 = await safeWait(adminBug.connect(attacker2).setFeeBps(9000, await txOpts()), "attack_access_setFeeBps", failures);
      await record(r1); await record(r2);
      truth.attack_events.push({ attack: "access_control", at: i, attacker: await attacker2.getAddress(), txs: [r1.hash, r2.hash] });
      continue;
    }

    if (i === attackPoints[2]) {
      const victim = users[Math.min(60, users.length - 1)];
      const victimAddr = await victim.getAddress();

      const a = await safeWait(token.connect(victim).approve(await attacker1.getAddress(), ethers.parseEther("10"), await txOpts()), "attack_allowance_approve", failures);
      const d = await safeWait(token.connect(attacker1).transferFrom(victimAddr, await attacker1.getAddress(), ethers.parseEther("10"), await txOpts()), "attack_allowance_drain", failures);

      await record(a); await record(d);
      truth.attack_events.push({ attack: "allowance_drain", at: i, attacker: await attacker1.getAddress(), victim: victimAddr, txs: [a.hash, d.hash] });
      continue;
    }

    if (i === attackPoints[3]) {
      const victim = users[Math.min(70, users.length - 1)];
      const victimAddr = await victim.getAddress();

      await setAutomine(false);

      const frontP = amm.connect(attacker1).swapStableForToken(ethers.parseEther("50"), await txOpts());
      const victimP = amm.connect(victim).swapStableForToken(ethers.parseEther("5"), await txOpts());
      const backP  = amm.connect(attacker1).swapTokenForStable(ethers.parseEther("40"), await txOpts());

      await mine();
      await setAutomine(true);
      await mine();

      const f = await safeWait(frontP, "attack_sandwich_front", failures);
      const v = await safeWait(victimP, "attack_sandwich_victim", failures);
      const b = await safeWait(backP,  "attack_sandwich_back", failures);

      await record(f); await record(v); await record(b);
      truth.attack_events.push({ attack: "sandwich", at: i, attacker: await attacker1.getAddress(), victim: victimAddr, txs: [f.hash, v.hash, b.hash] });
      continue;
    }

    if (i === attackPoints[4]) {
      const r1 = await safeWait(amm.connect(attacker1).swapStableForToken(ethers.parseEther("300"), await txOpts()), "attack_price_manip_1", failures);
      const r2 = await safeWait(amm.connect(attacker1).swapTokenForStable(ethers.parseEther("250"), await txOpts()), "attack_price_manip_2", failures);
      await record(r1); await record(r2);
      truth.attack_events.push({ attack: "price_manipulation_like", at: i, attacker: await attacker1.getAddress(), txs: [r1.hash, r2.hash] });
      continue;
    }

    await normalTx();

    if (i % 500 === 0) console.log(`SIM progress: ${i}/${TOTAL_TX}`);
  }

  // Persist sim output for audit (but not copied into TEAM_BUNDLE)
  writeJSON(path.join(base, "sim_output_full.json"), { txHashes, truth, failures });

  console.log(`SIM done. tx=${txHashes.length}, failures=${failures.length}`);

  // ---------------------------
  // 2) EXPORT RAW
  // ---------------------------
  console.log("RAW export starting…");

  const blocksW   = ndjsonWriter(rawDir, "blocks", SHARD_SIZE);
  const txsW      = ndjsonWriter(rawDir, "txs", SHARD_SIZE);
  const receiptsW = ndjsonWriter(rawDir, "receipts", SHARD_SIZE);
  const logsW     = ndjsonWriter(rawDir, "logs_events", SHARD_SIZE);
  const tracesW   = ndjsonWriter(rawDir, "traces_call", SHARD_SIZE);
  const snapsW    = ndjsonWriter(rawDir, "snapshots_balances", SHARD_SIZE);
  const stateDiffW = ndjsonWriter(rawDir, "prediff", SHARD_SIZE);

  const seenBlocks = new Set();

  // Snapshot address set (bounded)
  const snapAddrs = new Set();
  truth.attackers.forEach(a => a && snapAddrs.add(a));
  Object.values(truth.contracts).forEach(a => a && snapAddrs.add(a));

  let observedEOAs = 0;

  for (let i = 0; i < txHashes.length; i++) {
    const h = txHashes[i];
    const tx = await ethers.provider.getTransaction(h);
    const rc = await ethers.provider.getTransactionReceipt(h);
    if (!tx || !rc) continue;

    // grow snapshot set from seen parties (bounded)
    if (tx.from && observedEOAs < SNAPSHOT_USER_CAP && !snapAddrs.has(tx.from)) { snapAddrs.add(tx.from); observedEOAs++; }
    if (tx.to && observedEOAs < SNAPSHOT_USER_CAP && !snapAddrs.has(tx.to)) { snapAddrs.add(tx.to); observedEOAs++; }

    const block = await ethers.provider.getBlock(rc.blockHash);

    txsW.write({ doc_type: "tx", run_id: runId, ...tx });
    receiptsW.write({ doc_type: "receipt", run_id: runId, ...rc });

    if (block && !seenBlocks.has(block.hash)) {
      seenBlocks.add(block.hash);
      blocksW.write({ doc_type: "block", run_id: runId, ...block });
    }

    for (const lg of (rc.logs || [])) {
      logsW.write({ doc_type: "log", run_id: runId, tx_hash: h, ...lg });
    }

    const trace = await tryCallTrace(h);
    if (trace) tracesW.write({ doc_type: "trace_call", run_id: runId, tx_hash: h, block_number: rc.blockNumber, trace });

    const prestate = await tryPrestateTracer(h);
    if (prestate) {
      const stateDiffs = prestateToStateDiff(prestate, h, rc.blockNumber);
      for (const diff of stateDiffs) {
        stateDiffW.write({ doc_type: "prediff", run_id: runId, ...diff });
      }
    }

    // balance checkpoints
    if ((i + 1) % CHECKPOINT_EVERY === 0 || i === 0 || i === txHashes.length - 1) {
      const tag = rc.blockNumber;
      for (const a of snapAddrs) {
        try {
          const bal = await ethers.provider.getBalance(a, tag);
          snapsW.write({
            doc_type: "balance_snapshot",
            run_id: runId,
            at_block: tag,
            tx_hash: h,
            address: a,
            balance_wei: bal.toString()
          });
        } catch (_) {}
      }
    }

    if ((i + 1) % 500 === 0) console.log(`RAW: ${i + 1}/${txHashes.length}`);
  }

  blocksW.end(); txsW.end(); receiptsW.end(); logsW.end(); tracesW.end(); snapsW.end(); stateDiffW.end();

  // ---------------------------
  // 2b) ADDITIONAL RAW DATA (codes, token metadata, storage)
  // ---------------------------
  console.log("Collecting additional RAW data (codes, token metadata)…");

  const codesW = ndjsonWriter(rawDir, "codes", SHARD_SIZE);
  const tokenMetaW = ndjsonWriter(rawDir, "token_meta", SHARD_SIZE);
  const storageW = ndjsonWriter(rawDir, "storage_snapshots", SHARD_SIZE);

  // Collect eth_getCode for all key addresses
  for (const addr of snapAddrs) {
    try {
      const code = await ethers.provider.getCode(addr);
      codesW.write({
        doc_type: "code",
        run_id: runId,
        address: addr,
        code,
        code_length: code.length
      });
    } catch (_) {}
  }
  codesW.end();

  // Collect ERC20 metadata (name, symbol, decimals) for token contracts
  const tokenAddresses = [
    await token.getAddress(),
    await stable.getAddress()
  ];
  for (const tokenAddr of tokenAddresses) {
    try {
      const erc20Iface = new ethers.Interface([
        "function name() public view returns (string)",
        "function symbol() public view returns (string)",
        "function decimals() public view returns (uint8)"
      ]);
      const contract = new ethers.Contract(tokenAddr, erc20Iface, ethers.provider);
      
      let name, symbol, decimals;
      try { name = await contract.name(); } catch (_) { name = null; }
      try { symbol = await contract.symbol(); } catch (_) { symbol = null; }
      try { decimals = await contract.decimals(); } catch (_) { decimals = null; }

      tokenMetaW.write({
        doc_type: "token_meta",
        run_id: runId,
        token_address: tokenAddr,
        name,
        symbol,
        decimals: decimals !== null ? Number(decimals) : null
      });
    } catch (_) {}
  }
  tokenMetaW.end();

  // Optional: Targeted storage snapshots (safe, minimal)
  // Snapshot key storage slots for known contracts
  const storageTargets = {
    [await adminBug.getAddress()]: ["0x0", "0x1"], // treasury, feeBps
    [await vault.getAddress()]: ["0x0", "0x1"],    // deposits mapping, state
    [await amm.getAddress()]: ["0x0", "0x1", "0x2"] // reserve data
  };

  for (const [contractAddr, slots] of Object.entries(storageTargets)) {
    for (const slot of slots) {
      try {
        const value = await ethers.provider.getStorage(contractAddr, slot);
        storageW.write({
          doc_type: "storage_snapshot",
          run_id: runId,
          contract: contractAddr,
          slot,
          value
        });
      } catch (_) {}
    }
  }
  storageW.end();

  // ---------------------------
  // 3) DERIVE (no spoilers)
  // ---------------------------
  console.log("DERIVED generation starting…");

  const txEnrichedW = ndjsonWriter(derivedDir, "tx_enriched", SHARD_SIZE);
  const transfersW  = ndjsonWriter(derivedDir, "asset_transfers", SHARD_SIZE);
  const edgesW      = ndjsonWriter(derivedDir, "fund_flow_edges", SHARD_SIZE);
  const profilesW   = ndjsonWriter(derivedDir, "address_profile", SHARD_SIZE);
  const approvalsW  = ndjsonWriter(derivedDir, "approvals", SHARD_SIZE);
  const allowanceEdgesW = ndjsonWriter(derivedDir, "allowance_edges", SHARD_SIZE);
  const contractCallsW = ndjsonWriter(derivedDir, "contract_calls", SHARD_SIZE);
  const methodStatsW = ndjsonWriter(derivedDir, "method_stats", SHARD_SIZE);
  const traceEdgesW = ndjsonWriter(derivedDir, "trace_edges", SHARD_SIZE);
  const revertReasonsW = ndjsonWriter(derivedDir, "revert_reasons", SHARD_SIZE);
  const mempoolPendingW = ndjsonWriter(derivedDir, "mempool_pending", SHARD_SIZE);

  // Address profile aggregation (expanded to capture ALL tx activity)
  // key: address -> stats
  const prof = new Map();
  function getProf(a) {
    if (!prof.has(a)) {
      prof.set(a, {
        address: a,
        eth_in_wei:  "0",
        eth_out_wei: "0",
        eth_in_txs:  0,
        eth_out_txs: 0,
        erc20_in:  {},  // tokenAddr -> amount string
        erc20_out: {},
        tx_out_count: 0,    // count of txs where this is 'from'
        tx_in_count: 0,     // count of txs where this is 'to'
        gas_spent_wei: "0", // total gas cost in wei (gasUsed * effectiveGasPrice)
        total_gas_used: "0", // total gas units consumed
        first_seen_ts: null,
        last_seen_ts: null
      });
    }
    return prof.get(a);
  }
  function addBigStr(aStr, add) {
    const a = BigInt(aStr);
    return (a + add).toString();
  }

  // Method stats aggregation: (to_address, method_id) => stats
  const methodStats = new Map();
  function getMethodKey(to, methodId) {
    return `${to}|${methodId}`;
  }
  function getMethodStat(to, methodId) {
    const key = getMethodKey(to, methodId);
    if (!methodStats.has(key)) {
      methodStats.set(key, {
        to,
        method_id: methodId,
        count: 0,
        success_count: 0,
        revert_count: 0,
        callers: new Set(),
        first_seen_ts: null,
        last_seen_ts: null
      });
    }
    return methodStats.get(key);
  }

  for (let i = 0; i < txHashes.length; i++) {
    const h = txHashes[i];
    const tx = await ethers.provider.getTransaction(h);
    const rc = await ethers.provider.getTransactionReceipt(h);
    if (!tx || !rc) continue;

    const blk = await ethers.provider.getBlock(rc.blockHash);
    const ts = blk ? Number(blk.timestamp) : null;
    const txStatus = rc.status === 1 ? "success" : "revert";

    // tx intelligence (neutral)
    txEnrichedW.write({
      doc_type: "tx_enriched",
      run_id: runId,
      tx_hash: h,
      block_number: rc.blockNumber,
      timestamp: ts,
      status: txStatus,
      from: tx.from,
      to: tx.to,
      value_wei: tx.value ? tx.value.toString() : "0",
      gas_used: rc.gasUsed ? rc.gasUsed.toString() : null,
      gas_price: tx.gasPrice ? tx.gasPrice.toString() : null,
      logs_count: (rc.logs || []).length,
      method_id: tx.data ? tx.data.slice(0, 10) : "0x"
    });

    // CONTRACT CALLS derived: one row per tx
    const methodId = tx.data ? tx.data.slice(0, 10) : "0x";
    const gasPrice = tx.gasPrice ? BigInt(tx.gasPrice) : 1n;
    const gasUsed = rc.gasUsed ? BigInt(rc.gasUsed) : 0n;
    const effectiveGasPrice = gasPrice; // simplified; in EIP-1559 could use baseFeePerGas
    const gasCostWei = gasUsed * effectiveGasPrice;

    contractCallsW.write({
      doc_type: "contract_call",
      run_id: runId,
      tx_hash: h,
      from: tx.from,
      to: tx.to || null,  // null for contract creation
      method_id: methodId,
      status: txStatus,
      value_wei: (tx.value || 0n).toString(),
      gas_used: gasUsed.toString(),
      effective_gas_price: effectiveGasPrice.toString(),
      timestamp: ts,
      block_number: rc.blockNumber
    });

    // Update address profile (ALL tx activity)
    if (tx.from) {
      const pf = getProf(tx.from);
      pf.tx_out_count += 1;
      pf.gas_spent_wei = addBigStr(pf.gas_spent_wei, gasCostWei);
      pf.total_gas_used = addBigStr(pf.total_gas_used, gasUsed);
      if (pf.first_seen_ts === null || ts < pf.first_seen_ts) pf.first_seen_ts = ts;
      if (pf.last_seen_ts === null || ts > pf.last_seen_ts) pf.last_seen_ts = ts;
    }
    if (tx.to) {
      const pf = getProf(tx.to);
      pf.tx_in_count += 1;
      if (pf.first_seen_ts === null || ts < pf.first_seen_ts) pf.first_seen_ts = ts;
      if (pf.last_seen_ts === null || ts > pf.last_seen_ts) pf.last_seen_ts = ts;
    }

    // Update method stats
    if (tx.to && methodId !== "0x") {
      const stat = getMethodStat(tx.to, methodId);
      stat.count += 1;
      if (txStatus === "success") stat.success_count += 1;
      else stat.revert_count += 1;
      if (tx.from) stat.callers.add(tx.from);
      if (stat.first_seen_ts === null || ts < stat.first_seen_ts) stat.first_seen_ts = ts;
      if (stat.last_seen_ts === null || ts > stat.last_seen_ts) stat.last_seen_ts = ts;
    }

    // ETH transfer (value)
    if (tx.to && tx.value && tx.value > 0n) {
      const tr = {
        doc_type: "asset_transfer",
        run_id: runId,
        tx_hash: h,
        block_number: rc.blockNumber,
        timestamp: ts,
        asset_type: "native",
        asset: "ETH",
        from: tx.from,
        to: tx.to,
        amount_wei: tx.value.toString()
      };
      transfersW.write(tr);
      edgesW.write({
        doc_type: "fund_flow_edge",
        run_id: runId,
        tx_hash: h,
        block_number: rc.blockNumber,
        timestamp: ts,
        asset_type: "native",
        asset: "ETH",
        from: tx.from,
        to: tx.to,
        amount: tx.value.toString()
      });

      // profile update
      const pfFrom = getProf(tx.from);
      const pfTo = getProf(tx.to);
      pfFrom.eth_out_wei = addBigStr(pfFrom.eth_out_wei, tx.value);
      pfFrom.eth_out_txs += 1;
      pfTo.eth_in_wei = addBigStr(pfTo.eth_in_wei, tx.value);
      pfTo.eth_in_txs += 1;
    }

    // ERC20 Transfer events
    for (const lg of (rc.logs || [])) {
      if (!lg.topics || lg.topics.length < 3) continue;
      if ((lg.topics[0] || "").toLowerCase() !== TRANSFER_TOPIC0.toLowerCase()) continue;

      const from = topicToAddress(lg.topics[1]);
      const to = topicToAddress(lg.topics[2]);
      const amount = hexToBigInt(lg.data || "0x");

      const tokenAddr = lg.address;

      const tr = {
        doc_type: "asset_transfer",
        run_id: runId,
        tx_hash: h,
        block_number: rc.blockNumber,
        timestamp: ts,
        asset_type: "erc20",
        asset: tokenAddr,
        from,
        to,
        amount: amount.toString(),
        log_index: lg.logIndex?.toString?.() ?? lg.logIndex
      };
      transfersW.write(tr);
      edgesW.write({
        doc_type: "fund_flow_edge",
        run_id: runId,
        tx_hash: h,
        block_number: rc.blockNumber,
        timestamp: ts,
        asset_type: "erc20",
        asset: tokenAddr,
        from,
        to,
        amount: amount.toString()
      });

      // profile update
      if (from) {
        const p = getProf(from);
        p.erc20_out[tokenAddr] = (BigInt(p.erc20_out[tokenAddr] || "0") + amount).toString();
      }
      if (to) {
        const p = getProf(to);
        p.erc20_in[tokenAddr] = (BigInt(p.erc20_in[tokenAddr] || "0") + amount).toString();
      }
    }

    // TRACE EDGES derived: extract call graph from callTracer
    const trace = await tryCallTrace(h);
    if (trace) {
      tracesW.write({ doc_type: "trace_call", run_id: runId, tx_hash: h, block_number: rc.blockNumber, trace });

      // Parse call tree to extract edges
      function walkTrace(call, depth = 0) {
        if (!call) return;
        
        const { from, to, input, value, type } = call;
        if (from && to && type) {
          const selector = input && input.length >= 10 ? input.slice(0, 10) : null;
          traceEdgesW.write({
            doc_type: "trace_edge",
            run_id: runId,
            tx_hash: h,
            block_number: rc.blockNumber,
            timestamp: ts,
            caller: from,
            callee: to,
            call_type: type,
            value: (value || 0n).toString(),
            input_selector: selector,
            depth
          });
        }

        // Recurse into subcalls
        if (call.calls && Array.isArray(call.calls)) {
          for (const sub of call.calls) {
            walkTrace(sub, depth + 1);
          }
        }
      }
      walkTrace(trace);
    }

    // REVERT REASONS derived: best-effort extraction
    if (txStatus === "revert") {
      let reason = null;
      if (trace && trace.revertReason) {
        reason = trace.revertReason;
      } else if (rc.revertReason) {
        reason = rc.revertReason;
      }
      // If still no reason, try to decode common patterns from trace output
      if (!reason && trace && trace.output) {
        try {
          // Attempt to decode Error(string) revert reason
          const output = trace.output;
          if (output.startsWith("0x08c379a0")) {
            // Looks like Error(string) signature (keccak256 of "Error(string)")
            const reasonData = "0x" + output.slice(10);
            const reason_part = hexToBigInt(reasonData);
            // This is a simplified attempt; full decoding would use ethers ABI decoder
            reason = `encoded_error_${reason_part.toString().slice(0, 16)}...`;
          }
        } catch (_) {
          // Decoding failed, reason stays null
        }
      }

      revertReasonsW.write({
        doc_type: "revert_reason",
        run_id: runId,
        tx_hash: h,
        status: "revert",
        reason,
        timestamp: ts,
        block_number: rc.blockNumber
      });
    }

    // ERC20 Approval events
    for (let logIdx = 0; logIdx < (rc.logs || []).length; logIdx++) {
      const lg = rc.logs[logIdx];
      const approval = decodeApprovalEvent(lg);
      if (!approval) continue;

      const { owner, spender, value } = approval;
      const tokenAddr = lg.address;

      approvalsW.write({
        doc_type: "approval",
        run_id: runId,
        tx_hash: h,
        block_number: rc.blockNumber,
        timestamp: ts,
        token: tokenAddr,
        owner,
        spender,
        value: value.toString(),
        log_index: logIdx
      });

      allowanceEdgesW.write({
        doc_type: "allowance_edge",
        run_id: runId,
        tx_hash: h,
        block_number: rc.blockNumber,
        timestamp: ts,
        token: tokenAddr,
        from: owner,
        to: spender,
        amount: value.toString()
      });
    }

    if ((i + 1) % 500 === 0) console.log(`DERIVED: ${i + 1}/${txHashes.length}`);
  }

  // Flush address profiles
  for (const p of prof.values()) {
    profilesW.write({ doc_type: "address_profile", run_id: runId, ...p });
  }

  // Flush method stats aggregation: merged records
  for (const stat of methodStats.values()) {
    methodStatsW.write({
      doc_type: "method_stat",
      run_id: runId,
      to: stat.to,
      method_id: stat.method_id,
      count: stat.count,
      success_count: stat.success_count,
      revert_count: stat.revert_count,
      unique_callers: stat.callers.size,
      first_seen_ts: stat.first_seen_ts,
      last_seen_ts: stat.last_seen_ts
    });
  }

  // End all derived output writers
  txEnrichedW.end();
  transfersW.end();
  edgesW.end();
  profilesW.end();
  approvalsW.end();
  allowanceEdgesW.end();
  contractCallsW.end();
  methodStatsW.end();
  traceEdgesW.end();
  revertReasonsW.end();
  mempoolPendingW.end();

  // ---------------------------
  // 4) ABI EXPORT (contracts + helpers)
  // ---------------------------
  console.log("Exporting ABI data…");

  const abiDir = path.join(base, "ABI");
  const abiListDir = path.join(abiDir, "abi");
  const bytecodeDir = path.join(abiDir, "bytecode");
  
  ensureDir(abiListDir);
  ensureDir(bytecodeDir);

  // Helper: extract ABI and bytecode from artifacts using hre.artifacts API
  async function exportContractABI(contractName) {
    try {
      // Use official hardhat artifacts API
      const artifact = await hre.artifacts.readArtifact(contractName);
      
      // Export ABI
      if (artifact.abi) {
        writeJSON(path.join(abiListDir, `${contractName}.json`), artifact.abi);
      }
      
      // Export runtime bytecode (deployed bytecode) with fallback to creation bytecode
      let bytecodeToExport = null;
      if (artifact.deployedBytecode) {
        bytecodeToExport = artifact.deployedBytecode;
      } else if (artifact.bytecode) {
        bytecodeToExport = artifact.bytecode;
      }
      
      if (bytecodeToExport) {
        const bytecodeStr = bytecodeToExport.replace(/^0x/, "");
        writeText(path.join(bytecodeDir, `${contractName}.bin`), bytecodeStr);
      }
    } catch (e) {
      console.log(`  (Could not export ${contractName}: ${e.message})`);
    }
  }

  // Export ABIs for all deployed contracts
  const contractNames = ["TestToken", "VulnerableVault", "ReentrancyAttacker", "AdminConfigBug", "SimpleAMM"];
  for (const name of contractNames) {
    await exportContractABI(name);
  }

  // Create addresses.json (all key addresses)
  const addressesData = {
    run_id: runId,
    created_at: new Date().toISOString(),
    contracts: {
      token: await token.getAddress(),
      stable: await stable.getAddress(),
      vault: await vault.getAddress(),
      reent: await reent.getAddress(),
      amm: await amm.getAddress(),
      adminBug: await adminBug.getAddress()
    },
    attackers: truth.attackers,
    snapshotted_users: Array.from(snapAddrs)
      .filter(a => !banned.has(a) && !truth.attackers.includes(a))
      .slice(0, SNAPSHOT_USER_CAP)
  };
  writeJSON(path.join(abiDir, "addresses.json"), addressesData);

  // ---------------------------
  // 5) Bundle into TEAM + RESEARCH
  // ---------------------------
  console.log("Bundling…");

  const team = path.join(base, "TEAM_BUNDLE");
  const research = path.join(base, "RESEARCH_BUNDLE");

  ensureDir(team); ensureDir(research);

  // Function to copy ABI folder but exclude attacker contract ABIs for TEAM_BUNDLE
  function copyABIDirFiltered(src, dst, excludeAttackers = false) {
    ensureDir(dst);
    const attacker_contracts = ["ReentrancyAttacker", "AdminConfigBug"];
    
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      
      if (ent.isDirectory()) {
        // For abi and bytecode subdirs, filter files
        if (excludeAttackers && (ent.name === "abi" || ent.name === "bytecode")) {
          ensureDir(d);
          for (const file of fs.readdirSync(s, { withFileTypes: true })) {
            if (file.isFile()) {
              let isAttacker = false;
              for (const attacker of attacker_contracts) {
                if (file.name.includes(attacker)) {
                  isAttacker = true;
                  break;
                }
              }
              if (!isAttacker) {
                fs.copyFileSync(path.join(s, file.name), path.join(d, file.name));
              }
            }
          }
        } else {
          copyDir(s, d);
        }
      } else if (ent.name === "addresses.json" && excludeAttackers) {
        // Filter addresses.json to remove attacker contracts for TEAM_BUNDLE
        const fullAddrs = JSON.parse(fs.readFileSync(s, "utf8"));
        const filteredAddrs = {
          run_id: fullAddrs.run_id,
          created_at: fullAddrs.created_at,
          contracts: {
            token: fullAddrs.contracts.token,
            stable: fullAddrs.contracts.stable,
            vault: fullAddrs.contracts.vault,
            amm: fullAddrs.contracts.amm
            // reent and adminBug excluded for TEAM_BUNDLE
          },
          snapshotted_users: fullAddrs.snapshotted_users
          // attackers list excluded for TEAM_BUNDLE
        };
        writeJSON(d, filteredAddrs);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  // Copy RAW + DERIVED + ABI to both
  copyDir(rawDir, path.join(team, "RAW"));
  copyDir(derivedDir, path.join(team, "DERIVED"));
  copyABIDirFiltered(abiDir, path.join(team, "ABI"), true);  // Exclude attacker ABIs for TEAM

  copyDir(rawDir, path.join(research, "RAW"));
  copyDir(derivedDir, path.join(research, "DERIVED"));
  copyDir(abiDir, path.join(research, "ABI"));  // Full ABIs for RESEARCH

  // TEAM README (no spoilers)
  writeText(path.join(team, "README.md"),
`TEAM_BUNDLE (RAW + DERIVED)

Purpose:
- Client-style evidence bundle for forensic investigation.
- Contains no ground truth / attacker identity.

Contents:
- RAW: blocks, txs, receipts, event logs, best-effort call traces, balance snapshots.
- DERIVED: neutral enrichments + transfer lists + flow edges + address profiles.

Notes:
- Some transactions may revert (realistic). See receipts.status and DERIVED.tx_enriched.status.
`);

  // RESEARCH truth + decoded timeline
  writeJSON(path.join(research, "TRUTH", "actors.json"), {
    attackers: truth.attackers,
    contracts: truth.contracts
  });
  writeJSON(path.join(research, "TRUTH", "attack_plan.json"), truth.attack_events);

  const timelineLines = [];
  timelineLines.push(`# Timeline (ground truth)\n`);
  timelineLines.push(`Run: ${runId}`);
  timelineLines.push(`ChainId: ${Number(net.chainId)}`);
  timelineLines.push(`Seed: ${SEED}`);
  timelineLines.push(`\n## Attack injections\n`);
  for (const ev of truth.attack_events) {
    timelineLines.push(`- at txIndex=${ev.at} attack=${ev.attack} attacker=${ev.attacker} tx=${ev.tx || ""} txs=${(ev.txs || []).filter(Boolean).join(", ")}`);
  }
  writeText(path.join(research, "DECODED", "timeline.md"), timelineLines.join("\n") + "\n");

  writeText(path.join(research, "README.md"),
`RESEARCH_BUNDLE (RAW + DERIVED + TRUTH + DECODED)

This bundle includes spoilers:
- TRUTH: attacker identities, contract roles, injection plan
- DECODED: timeline.md explaining what happened (ground truth)

Use this to validate the team's findings or create training material.
`);

  // ---------------------------
  // 6) Integrity hashes
  // ---------------------------
  function hashTree(rootDir, outFile) {
    const files = [];
    function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else files.push(p);
      }
    }
    walk(rootDir);
    files.sort();
    const lines = files.map(f => `${sha256File(f)}  ${f.replace(/\\/g, "/")}`);
    writeText(outFile, lines.join("\n") + "\n");
  }

  // Create RUN_META.json content
  const head1 = await ethers.provider.getBlockNumber();
  const runMetaData = {
    run_id: runId,
    chain_id: Number(net.chainId),
    created_at: new Date().toISOString(),
    head_block_start: head0,
    head_block_end: head1,
    total_tx_requested: TOTAL_TX,
    user_count: USER_COUNT,
    shard_size: SHARD_SIZE,
    checkpoint_every: CHECKPOINT_EVERY,
    snapshot_user_cap: SNAPSHOT_USER_CAP,
    tx_exported_success: txHashes.length,
    failures_count: failures.length,
    notes: {
      traces: "best-effort via debug_traceTransaction(callTracer); may be missing if node doesn't support; used to extract trace_edges",
      prediff: "best-effort via debug_traceTransaction(prestateTracer); Anvil limitation: only pre-state available (mode='prestate_only'). balance_after and storage_after are null. Balances normalized from hex to decimal strings.",
      approvals: "ERC20 Approval events decoded from receipt logs; enables allowance abuse detection",
      allowance_edges: "approval events as directed edges for graph analysis",
      address_profile: "EXPANDED: now captures ALL tx activity (tx_out_count, tx_in_count, gas_spent_wei, total_gas_used, first_seen_ts, last_seen_ts) in addition to ETH/ERC20 flows. Every participant is now profileable.",
      contract_calls: "NEW: one row per transaction, extracted with method_id, status, gas costs, and timing. Enables contract interaction pattern detection.",
      method_stats: "NEW: aggregated statistics per (to_address, method_id) pair. Includes count, success/revert counts, unique callers, and temporal window. Identifies hot methods.",
      trace_edges: "NEW: call graph edges extracted from callTracer output. Each edge: caller, callee, call_type, value, input_selector, depth. Enables execution flow reconstruction.",
      revert_reasons: "NEW: best-effort extraction of revert reasons from trace output. reason field may be null if unavailable. Only written for reverted txs.",
      mempool_pending: "OPTIONAL: best-effort capture of pending txs in local Anvil simulation. NOTE: Mempool is ephemeral and not queryable historically on real nodes. This is simulation-specific; do not expect equivalent data in real incidents.",
      codes: "eth_getCode for all snapshotted addresses (contracts + bounded EOAs)",
      token_meta: "ERC20 name/symbol/decimals for token contracts",
      storage_snapshots: "targeted storage reads for key contract slots (safe, minimal)",
      abi_export: "ABI files (JSON), runtime bytecode (*.bin), and address mappings in ABI/ directory. Bytecode is runtime (deployedBytecode preferred) for on-chain detection."
    }
  };

  // Copy RUN_META.json to both bundles
  writeJSON(path.join(team, "RUN_META.json"), runMetaData);
  writeJSON(path.join(research, "RUN_META.json"), runMetaData);

  hashTree(team, path.join(team, "hashes.sha256"));
  hashTree(research, path.join(research, "hashes.sha256"));

  // ---------------------------
  // 7) Cleanup root folders (already in bundles)
  // ---------------------------
  function removeDir(p) {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
  
  removeDir(rawDir);
  removeDir(derivedDir);
  removeDir(abiDir);

  console.log("DONE ✅");
  console.log("Run folder:", base);
  console.log("TEAM_BUNDLE:", team);
  console.log("RESEARCH_BUNDLE:", research);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
