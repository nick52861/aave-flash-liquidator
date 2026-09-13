process.stdout._handle && process.stdout._handle.setBlocking && process.stdout._handle.setBlocking(true);
import http from "http";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { Worker } from "worker_threads";

dotenv.config();

// -------------------------------------------------------------------
// BACK4APP DUMMY HEALTH CHECK (Satisfies Port 8080 Probe)
// -------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[HEALTH] Dummy listener active on port ${PORT}`);
});

// -------------------------------------------------------------------
// CONFIGURATION
// -------------------------------------------------------------------
const RAW_RPC_URL = process.env.BASE_RPC_URL || "wss://mainnet.base.org/ws";
const HTTP_RPC_URL = process.env.HTTP_RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Flashbots Relay / Private RPC for Base
const FLASHBOTS_RELAY_URL = process.env.FLASHBOTS_RELAY_URL || "https://rpc.flashbots.net/base";

// ntfy.sh Topic for Push Notifications (Zero-signup log streaming)
const NTFY_TOPIC = process.env.NTFY_TOPIC || "aave-liquidator-logs-98123";

let contractAddr = process.env.CONTRACT_ADDRESS || "0x4b40aCb12A39312bb00d491a8baAf363bcAE8Bc7";
if (contractAddr.startsWith("0x0x")) contractAddr = contractAddr.replace("0x0x", "0x");
const FLASH_LIQUIDATOR_ADDRESS = contractAddr;

const POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const CACHE_FILE = path.join(process.cwd(), "borrowers.json");

// Cap real-time block audits to top 20 targets to maintain sub-30ms performance
const MAX_WATCHLIST_SIZE = 20;

// Native WebSocket Driver State
let wsClient;
let wsPingInterval;
let requestId = 1;
const rpcCallbacks = new Map();

// Runtime Application State
const targetUsers = new Set();
let activeWatchlist = [];
let cachedCallsArray = [];
const precalculatedCalls = new Map();
const pendingLiquidations = new Set();

let isWorkerScanning = false;
let isAuditing = false; // Lock to prevent WS block stacking
let blockCounter = 0;
let currentBlockNumber = 0;

let currentNonce = null;
let cachedMaxFeePerGas = null;
let cachedMaxPriorityFeePerGas = null;

// -------------------------------------------------------------------
// HEADLESS PUSH LOGGER (STDOUT + NTFY.SH)
// -------------------------------------------------------------------
async function logger(msg, title = "Aave Liquidator") {
  const timestamp = new Date().toISOString();
  const formattedMsg = `[${timestamp}] ${msg}`;
  
  // Standard stdout log for Back4app Container Console
  console.log(formattedMsg);

  // Dispatch push alert for critical actions or errors via ntfy.sh
  if (msg.includes("🚨") || msg.includes("🚀") || msg.includes("❌") || msg.includes("⚠️") || msg.includes("🤖")) {
    try {
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: "POST",
        headers: { "Title": title, "Priority": msg.includes("🚨") ? "high" : "default" },
        body: msg
      });
    } catch (err) {
      // Non-blocking log failure
    }
  }
}

// -------------------------------------------------------------------
// ABI INTERFACES & PROVIDERS
// -------------------------------------------------------------------
const poolInterface = new ethers.Interface([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
]);

const multicallInterface = new ethers.Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)"
]);

const flashLiquidatorInterface = new ethers.Interface([
  "function executeFlashLiquidation(address collateralAsset, address debtAsset, address targetUser, uint256 debtToCover, uint24 poolFee) external"
]);

// Providers & Wallet
const provider = new ethers.JsonRpcProvider(HTTP_RPC_URL, 8453, { staticNetwork: true });
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// -------------------------------------------------------------------
// FAST PRE-ENCODING & WATCHLIST MANAGEMENT
// -------------------------------------------------------------------
function precalculateCallStruct(user) {
  if (!precalculatedCalls.has(user)) {
    const callData = poolInterface.encodeFunctionData("getUserAccountData", [user]);
    precalculatedCalls.set(user, {
      target: POOL_ADDRESS,
      allowFailure: true,
      callData: callData
    });
  }
  return precalculatedCalls.get(user);
}

function updateWatchlistCalls(newList) {
  activeWatchlist = newList.slice(0, MAX_WATCHLIST_SIZE);
  
  cachedCallsArray = new Array(activeWatchlist.length);
  for (let i = 0; i < activeWatchlist.length; i++) {
    cachedCallsArray[i] = precalculateCallStruct(activeWatchlist[i]);
  }
}

function loadCachedBorrowers() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsedData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(parsedData)) {
        parsedData.forEach((addr) => {
          if (ethers.isAddress(addr) && addr !== ethers.ZeroAddress) {
            targetUsers.add(addr);
            precalculateCallStruct(addr);
          }
        });
        logger(`📂 Loaded ${targetUsers.size} cached borrowers from borrowers.json`);
      }
    }
  } catch (err) {
    logger(`⚠️ Cache load error: ${err.message}`);
  }
}

// -------------------------------------------------------------------
// STATE PRE-WARMING (NONCE & GAS FEE SYNC)
// -------------------------------------------------------------------
async function syncGasAndNonce() {
  try {
    const [feeData, nonce] = await Promise.all([
      provider.getFeeData(),
      provider.getTransactionCount(wallet.address, "pending")
    ]);
    
    if (feeData.maxFeePerGas) {
      cachedMaxFeePerGas = (feeData.maxFeePerGas * 120n) / 100n;
    }
    if (feeData.maxPriorityFeePerGas) {
      cachedMaxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 120n) / 100n;
    }
    currentNonce = nonce;
  } catch (err) {
    logger(`⚠️ Gas/Nonce sync error: ${err.message}`);
  }
}

// -------------------------------------------------------------------
// BACKGROUND WORKER (BACKGROUND SCAN)
// -------------------------------------------------------------------
function triggerBackgroundFullScan() {
  if (isWorkerScanning || targetUsers.size === 0) return;
  isWorkerScanning = true;

  const worker = new Worker(path.join(process.cwd(), "scripts", "fullScanWorker.js"), {
    workerData: {
      rpcUrl: HTTP_RPC_URL,
      poolAddress: POOL_ADDRESS,
      multicallAddress: MULTICALL3_ADDRESS,
      targets: Array.from(targetUsers),
    },
  });

  worker.on("message", (data) => {
    if (data.watchlist) {
      updateWatchlistCalls(data.watchlist);
      logger(`⚡ [FULL SCAN WORKER] Scanned ${data.scannedCount} users in ${data.durationMs}ms | Active Positions: ${data.activePositionsFound || 0} | Watchlist Capped At: ${activeWatchlist.length}`);
    }
    isWorkerScanning = false;
  });

  worker.on("error", (err) => { 
    logger(`⚠️ Worker Error: ${err.message}`);
    isWorkerScanning = false; 
  });
  worker.on("exit", () => { isWorkerScanning = false; });
}

// -------------------------------------------------------------------
// RAW WEBSOCKET CLIENT MANAGEMENT
// -------------------------------------------------------------------
function sendRawRpcRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = requestId++;
    rpcCallbacks.set(id, { resolve, reject });
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(payload);
    } else {
      reject(new Error("WebSocket not connected"));
    }
  });
}

function initWebSocketClient() {
  if (wsPingInterval) clearInterval(wsPingInterval);
  wsClient = new WebSocket(RAW_RPC_URL);

  wsClient.on("open", () => {
    logger("⚡ Low-Latency Native WebSocket Driver Connected.");
    wsClient.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 999,
      method: "eth_subscribe",
      params: ["newHeads"]
    }));

    // Keep WebSocket connection alive with RPC pings
    wsPingInterval = setInterval(() => {
      if (wsClient.readyState === WebSocket.OPEN) {
        wsClient.ping();
      }
    }, 20000);
  });

  wsClient.on("message", (data) => {
    try {
      const response = JSON.parse(data.toString());

      if (response.id && rpcCallbacks.has(response.id)) {
        const { resolve, reject } = rpcCallbacks.get(response.id);
        rpcCallbacks.delete(response.id);
        if (response.error) reject(response.error);
        else resolve(response.result);
        return;
      }

      if (response.method === "eth_subscription") {
        const blockNumHex = response.params?.result?.number;
        if (blockNumHex) {
          currentBlockNumber = parseInt(blockNumHex, 16);
          auditWatchlistRaw(currentBlockNumber);
        }
      }
    } catch (err) {
      logger(`⚠️ WS Message Processing Error: ${err.message}`);
    }
  });

  wsClient.on("error", (err) => logger(`⚠️ WS Driver Error: ${err.message}`));
  wsClient.on("close", () => {
    logger("⚠️ WS Connection lost. Reconnecting in 1s...");
    if (wsPingInterval) clearInterval(wsPingInterval);
    setTimeout(initWebSocketClient, 1000);
  });
}

// -------------------------------------------------------------------
// SUB-30MS WATCHLIST AUDIT LOOP
// -------------------------------------------------------------------
async function auditWatchlistRaw(blockNumber) {
  blockCounter++;
  if (blockCounter % 50 === 1) triggerBackgroundFullScan();
  
  if (cachedCallsArray.length === 0 || isAuditing) return;

  isAuditing = true;
  const startTime = Date.now();

  try {
    const calldataHex = multicallInterface.encodeFunctionData("aggregate3", [cachedCallsArray]);

    const rawHexResult = await sendRawRpcRequest("eth_call", [
      { to: MULTICALL3_ADDRESS, data: calldataHex },
      "latest"
    ]);

    if (!rawHexResult || rawHexResult === "0x") {
      isAuditing = false;
      return;
    }

    const decoded = multicallInterface.decodeFunctionResult("aggregate3", rawHexResult);
    const results = decoded[0];

    for (let i = 0; i < results.length; i++) {
      const { success, returnData } = results[i];
      if (!success || returnData === "0x") continue;

      const user = activeWatchlist[i];
      const parsedData = poolInterface.decodeFunctionResult("getUserAccountData", returnData);

      const totalDebtUSD = Number(parsedData.totalDebtBase) / 1e8;
      const healthFactor = Number(parsedData.healthFactor) / 1e18;

      if (totalDebtUSD > 10 && healthFactor < 1.0) {
        logger(`🚨 INSOLVENT TARGET FOUND: ${user} | Debt: $${totalDebtUSD.toFixed(2)} | HF: ${healthFactor.toFixed(4)}`);
        executeLiquidationBundle(user, healthFactor, totalDebtUSD);
      }
    }

    const elapsed = Date.now() - startTime;
    logger(`⚡ [Block #${blockNumber}] [WATCHLIST] Audited ${activeWatchlist.length} targets in ${elapsed}ms`);
  } catch (err) {
    logger(`⚠️ Watchlist audit error on block #${blockNumber}: ${err.message || err}`);
  } finally {
    isAuditing = false;
  }
}

// -------------------------------------------------------------------
// EXECUTION METHOD: FLASHBOTS BUNDLE SUBMISSION
// -------------------------------------------------------------------
async function executeLiquidationBundle(targetUser, healthFactor, totalDebtUSD) {
  if (pendingLiquidations.has(targetUser)) return;
  pendingLiquidations.add(targetUser);

  try {
    logger(`🚀 Executing Flashbots Bundle Liquidation on target: ${targetUser}`);
    
    const closeFactor = healthFactor > 0.95 ? 0.50 : 1.00;
    const debtToCover = ethers.parseUnits((totalDebtUSD * closeFactor).toFixed(6), 6);
    const UNISWAP_V3_FEE = 500;

    const calldata = flashLiquidatorInterface.encodeFunctionData("executeFlashLiquidation", [
      WETH_ADDRESS,
      USDC_ADDRESS,
      targetUser,
      debtToCover,
      UNISWAP_V3_FEE,
    ]);

    const targetNonce = currentNonce !== null ? currentNonce++ : await provider.getTransactionCount(wallet.address, "pending");

    const txUnsigned = {
      to: FLASH_LIQUIDATOR_ADDRESS,
      data: calldata,
      gasLimit: 800000n,
      maxFeePerGas: cachedMaxFeePerGas,
      maxPriorityFeePerGas: cachedMaxPriorityFeePerGas,
      nonce: targetNonce,
      chainId: 8453,
      type: 2,
    };

    const signedTxHex = await wallet.signTransaction(txUnsigned);
    const targetBlock = currentBlockNumber > 0 ? currentBlockNumber + 1 : await provider.getBlockNumber() + 1;
    const targetBlockHex = "0x" + targetBlock.toString(16);

    const bundlePayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendBundle",
      params: [
        {
          txs: [signedTxHex],
          blockNumber: targetBlockHex,
        },
      ],
    };

    logger(`📦 Submitting Flashbots Bundle targeting block #${targetBlock}...`);

    const response = await fetch(FLASHBOTS_RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundlePayload),
    });

    const result = await response.json();

    if (result.error) {
      logger(`❌ Flashbots Bundle Relay Error: ${result.error.message || result.error}`);
      syncGasAndNonce();
    } else {
      logger(`⚡ Bundle Submitted Successfully! Response: ${JSON.stringify(result.result || result)}`);
    }
  } catch (err) {
    logger(`❌ Execution Failed: ${err.reason || err.message}`);
    syncGasAndNonce();
  } finally {
    pendingLiquidations.delete(targetUser);
  }
}

// -------------------------------------------------------------------
// PROCESS EXCEPTION HANDLERS & EVENT LOOP KEEP-ALIVE
// -------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  logger(`⚠️ Global Uncaught Exception: ${err.message || err}`);
});

process.on("unhandledRejection", (reason, promise) => {
  logger(`⚠️ Global Unhandled Rejection at: ${promise} reason: ${reason}`);
});

process.on("SIGTERM", async () => {
  await logger("🛑 SIGTERM received. Shutting down worker gracefully...");
  process.exit(0);
});

// Force Node.js event loop to remain active continuously without open HTTP ports
setInterval(() => {}, 1000 * 60 * 60);

// -------------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------------
async function main() {
  await logger("====================================================");
  await logger("🤖 Aave V3 Headless Liquidator Worker (Back4app)");
  await logger(`Deployer Wallet: ${wallet.address}`);
  await logger(`Contract:        ${FLASH_LIQUIDATOR_ADDRESS}`);
  await logger(`Flashbots Relay: ${FLASHBOTS_RELAY_URL}`);
  await logger(`ntfy Topic:      https://ntfy.sh/${NTFY_TOPIC}`);
  await logger("====================================================\n");

  loadCachedBorrowers();
  await syncGasAndNonce();
  
  triggerBackgroundFullScan();
  setInterval(syncGasAndNonce, 10000);

  initWebSocketClient();
}

main().catch((err) => logger(`Fatal startup error: ${err.message || err}`));