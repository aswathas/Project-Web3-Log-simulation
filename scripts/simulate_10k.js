const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const { NonceManager } = require("ethers");

// ---------- utils ----------
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

async function setAutomine(on) {
  await ethers.provider.send("evm_setAutomine", [on]);
}
async function mine() {
  await ethers.provider.send("evm_mine", []);
}

// explicit gasPrice to avoid "replacement transaction underpriced"
async function txOpts() {
  const fee = await ethers.provider.getFeeData();
  const gp = fee.gasPrice ?? 1n;
  return { gasPrice: gp + 2n };
}

// Never let one revert kill the whole run
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

async function main() {
  const TOTAL_TX = envInt("TOTAL_TX", 10000);
  const USER_COUNT = envInt("USER_COUNT", 1000);
  const SEED = envInt("SEED", 1337);

  const R = rng(SEED);

  // Pull signers from HRE, wrap with NonceManager
  const rawSigners = await hre.ethers.getSigners();
  const signers = rawSigners.map((s) => new NonceManager(s));

  if (signers.length < USER_COUNT + 5) {
    throw new Error(
      `Not enough accounts: have ${signers.length}, need at least ${USER_COUNT + 5}. ` +
        `Start anvil with --accounts ${USER_COUNT + 5} and match mnemonic in hardhat.config.js`
    );
  }

  const deployer = signers[0];
  const users = signers.slice(1, 1 + USER_COUNT);
  const attacker1 = signers[1 + USER_COUNT];
  const attacker2 = signers[2 + USER_COUNT];

  // ---------- Deploy (WAIT for each deployment to avoid target=null) ----------
  const Token = await ethers.getContractFactory("TestToken");

  const token = await Token.connect(deployer).deploy(
    "TEST",
    "TST",
    ethers.parseEther("1000000"),
    await txOpts()
  );
  await token.waitForDeployment();

  const stable = await Token.connect(deployer).deploy(
    "STABLE",
    "STB",
    ethers.parseEther("1000000"),
    await txOpts()
  );
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
  const amm = await AMM.connect(deployer).deploy(
    await token.getAddress(),
    await stable.getAddress(),
    await txOpts()
  );
  await amm.waitForDeployment();

  // Never randomly send ETH to these
  const banned = new Set([
    await token.getAddress(),
    await stable.getAddress(),
    await vault.getAddress(),
    await reent.getAddress(),
    await amm.getAddress(),
    await adminBug.getAddress(),
  ]);

  // ---------- Seed AMM + distribute tokens ----------
  await (await token.connect(deployer).mint(await deployer.getAddress(), ethers.parseEther("200000"), await txOpts())).wait();
  await (await stable.connect(deployer).mint(await deployer.getAddress(), ethers.parseEther("200000"), await txOpts())).wait();

  await (await token.connect(deployer).approve(await amm.getAddress(), ethers.parseEther("100000"), await txOpts())).wait();
  await (await stable.connect(deployer).approve(await amm.getAddress(), ethers.parseEther("100000"), await txOpts())).wait();
  await (await amm.connect(deployer).seed(ethers.parseEther("100000"), ethers.parseEther("100000"), await txOpts())).wait();

  // Fund users + approvals
  for (let i = 0; i < users.length; i++) {
    const ua = await users[i].getAddress();
    await (await token.connect(deployer).mint(ua, ethers.parseEther("100"), await txOpts())).wait();
    await (await stable.connect(deployer).mint(ua, ethers.parseEther("100"), await txOpts())).wait();

    await (await token.connect(users[i]).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();
    await (await stable.connect(users[i]).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();

    if ((i + 1) % 50 === 0) console.log(`funded+approved ${i + 1}/${users.length} users`);
  }

  // Fund attackers
  await (await token.connect(deployer).mint(await attacker1.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();
  await (await stable.connect(deployer).mint(await attacker1.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();
  await (await token.connect(deployer).mint(await attacker2.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();
  await (await stable.connect(deployer).mint(await attacker2.getAddress(), ethers.parseEther("1000"), await txOpts())).wait();

  await (await token.connect(attacker1).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();
  await (await stable.connect(attacker1).approve(await amm.getAddress(), ethers.MaxUint256, await txOpts())).wait();

  // Fund vault so reentrancy has something to drain
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
    attack_events: [],
  };

  async function record(res) {
    if (res.ok && res.hash) txHashes.push(res.hash);
  }

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

  async function normalTx(i) {
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

  // 5 injection points
  const attackPoints = [
    Math.floor(TOTAL_TX * 0.15),
    Math.floor(TOTAL_TX * 0.35),
    Math.floor(TOTAL_TX * 0.55),
    Math.floor(TOTAL_TX * 0.75),
    Math.floor(TOTAL_TX * 0.9),
  ];

  for (let i = 1; i <= TOTAL_TX; i++) {
    // Attack 1: Reentrancy
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

    // Attack 2: Access control misuse
    if (i === attackPoints[1]) {
      const r1 = await safeWait(
        adminBug.connect(attacker2).setTreasury(await attacker2.getAddress(), await txOpts()),
        "attack_access_setTreasury",
        failures
      );
      const r2 = await safeWait(
        adminBug.connect(attacker2).setFeeBps(9000, await txOpts()),
        "attack_access_setFeeBps",
        failures
      );
      await record(r1);
      await record(r2);
      truth.attack_events.push({ attack: "access_control", at: i, attacker: await attacker2.getAddress(), txs: [r1.hash, r2.hash] });
      continue;
    }

    // Attack 3: Allowance drain
    if (i === attackPoints[2]) {
      const victim = users[Math.min(60, users.length - 1)];
      const victimAddr = await victim.getAddress();

      const a = await safeWait(
        token.connect(victim).approve(await attacker1.getAddress(), ethers.parseEther("10"), await txOpts()),
        "attack_allowance_approve",
        failures
      );
      const d = await safeWait(
        token.connect(attacker1).transferFrom(victimAddr, await attacker1.getAddress(), ethers.parseEther("10"), await txOpts()),
        "attack_allowance_drain",
        failures
      );

      await record(a);
      await record(d);

      truth.attack_events.push({
        attack: "allowance_drain",
        at: i,
        attacker: await attacker1.getAddress(),
        victim: victimAddr,
        txs: [a.hash, d.hash],
      });
      continue;
    }

    // Attack 4: Sandwich (same block)
    if (i === attackPoints[3]) {
      const victim = users[Math.min(70, users.length - 1)];
      const victimAddr = await victim.getAddress();

      await setAutomine(false);

      const frontP = amm.connect(attacker1).swapStableForToken(ethers.parseEther("50"), await txOpts());
      const victimP = amm.connect(victim).swapStableForToken(ethers.parseEther("5"), await txOpts());
      const backP = amm.connect(attacker1).swapTokenForStable(ethers.parseEther("40"), await txOpts());

      await mine();
      await setAutomine(true);
      await mine();

      const f = await safeWait(frontP, "attack_sandwich_front", failures);
      const v = await safeWait(victimP, "attack_sandwich_victim", failures);
      const b = await safeWait(backP, "attack_sandwich_back", failures);

      await record(f);
      await record(v);
      await record(b);

      truth.attack_events.push({
        attack: "sandwich",
        at: i,
        attacker: await attacker1.getAddress(),
        victim: victimAddr,
        txs: [f.hash, v.hash, b.hash],
      });
      continue;
    }

    // Attack 5: Price manipulation-like
    if (i === attackPoints[4]) {
      const r1 = await safeWait(
        amm.connect(attacker1).swapStableForToken(ethers.parseEther("300"), await txOpts()),
        "attack_price_manip_1",
        failures
      );
      const r2 = await safeWait(
        amm.connect(attacker1).swapTokenForStable(ethers.parseEther("250"), await txOpts()),
        "attack_price_manip_2",
        failures
      );

      await record(r1);
      await record(r2);

      truth.attack_events.push({
        attack: "price_manipulation_like",
        at: i,
        attacker: await attacker1.getAddress(),
        txs: [r1.hash, r2.hash],
      });
      continue;
    }

    await normalTx(i);

    if (i % 200 === 0) console.log(`progress: ${i}/${TOTAL_TX}`);
  }

  console.log("SIM DONE");
  console.log("successful tx count:", txHashes.length);
  console.log("failure count:", failures.length);
  console.log("first tx:", txHashes[0]);

  fs.writeFileSync("sim_output.json", JSON.stringify({ txHashes, truth, failures }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
