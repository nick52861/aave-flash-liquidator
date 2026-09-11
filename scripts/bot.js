process.stdout._handle && process.stdout._handle.setBlocking && process.stdout._handle.setBlocking(true);
import { ethers } from "ethers";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { Worker } from "worker_threads";

dotenv.config();

// -------------------------------------------------------------------
// CONFIGURATION
// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const RAW_RPC_URL = process.env.BASE_RPC_URL || "wss://mainnet.base.org/ws";
const HTTP_RPC_URL = process.env.HTTP_RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Flashbots Relay / Private RPC for Base
const FLASHBOTS_RELAY_URL = process.env.FLASHBOTS_RELAY_URL || "https://rpc.flashbots.net/base";

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
// IN-MEMORY LIVE LOG BUFFER & LOGGER
// -------------------------------------------------------------------
const recentLogs = [];
const MAX_LOG_BUFFER = 100;

function logger(msg) {
  const timestamp = new Date().toISOString();
  const formattedMsg = `[${timestamp}] ${msg}`;
  
  // Standard console log for stdout
  console.log(formattedMsg);
  
  // Store in circular buffer for /logs endpoint
  recentLogs.push(formattedMsg);
  if (recentLogs.length > MAX_LOG_BUFFER) {
    recentLogs.shift();
  }
}

// -------------------------------------------------------------------
// BACK4APP KEEP-ALIVE & HEALTH CHECK SERVER
// -------------------------------------------------------------------
const app = express();

const getHealthStatus = () => ({
  status: "OK",
  service: "Aave V3 Flashbots Liquidator",
  uptimeSeconds: Math.floor(process.uptime()),
  currentBlock: currentBlockNumber,
  wsConnected: wsClient?.readyState === WebSocket.OPEN,
  watchlistSize: activeWatchlist.length,
  totalCachedBorrowers: targetUsers.size,
  isScanning: isWorkerScanning,
  timestamp: new Date().toISOString()
});

app.get("/", (_, res) => res.status(200).send("🤖 Aave V3 Sub-30ms Liquidator Active & Running on Back4app"));
app.get("/health", (_, res) => res.status(200).json(getHealthStatus()));

// Live streaming log route (solves real-time logging issue)
app.get("/logs", (_, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send(recentLogs.join("\n") || "No logs available yet.");
});

app.listen(PORT, "0.0.0.0", () => {
  logger(`🌐 Back4app Health Check Server listening on port ${PORT}`);
});

// Self Keep-Alive Ping (Prevents Back4app Container Sleep / Idle Termination)
setInterval(() => {
  fetch(`http://127.0.0.1:${PORT}/health`)
    .catch(() => {}); // Silent catch for internal loopback
}, 4 * 60 * 1000); // Ping every 4 minutes

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
// EXECUTION METHOD 2: FLASHBOTS BUNDLE SUBMISSION (eth_sendBundle)
// -------------------------------------------------------------------
async function executeLiquidationBundle(targetUser, healthFactor, totalDebtUSD) {
  if (pendingLiquidations.has(targetUser)) return;
  pendingLiquidations.add(targetUser);

  try {
    logger(`🚀 Executing Flashbots Bundle Liquidation on target: ${targetUser}`);
    
    const closeFactor = healthFactor > 0.95 ? 0.50 : 1.00;
    const debtToCover = ethers.parseUnits((totalDebtUSD * closeFactor).toFixed(6), 6);
    const UNISWAP_V3_FEE = 500;

    // 1. Local Offline Calldata Encoding
    const calldata = flashLiquidatorInterface.encodeFunctionData("executeFlashLiquidation", [
      WETH_ADDRESS,
      USDC_ADDRESS,
      targetUser,
      debtToCover,
      UNISWAP_V3_FEE,
    ]);

    const targetNonce = currentNonce !== null ? currentNonce++ : await provider.getTransactionCount(wallet.address, "pending");

    // 2. Build Unsigned EIP-1559 Transaction Object
    const txUnsigned = {
      to: FLASH_LIQUIDATOR_ADDRESS,
      data: calldata,
      gasLimit: 800000n,
      maxFeePerGas: cachedMaxFeePerGas,
      maxPriorityFeePerGas: cachedMaxPriorityFeePerGas,
      nonce: targetNonce,
      chainId: 8453, // Base Mainnet
      type: 2,
    };

    // 3. Sign Locally (Zero-Delay)
    const signedTxHex = await wallet.signTransaction(txUnsigned);

    // Target immediate next block
    const targetBlock = currentBlockNumber > 0 ? currentBlockNumber + 1 : await provider.getBlockNumber() + 1;
    const targetBlockHex = "0x" + targetBlock.toString(16);

    // 4. Construct Flashbots eth_sendBundle JSON-RPC Payload
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

    // 5. Send Bundle Payload to Flashbots Relay Endpoint
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
// PROCESS EXCEPTION HANDLERS (KEEPS BOT ALIVE ON UNEXPECTED ERRORS)
// -------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  logger(`⚠️ Global Uncaught Exception: ${err.message || err}`);
});

process.on("unhandledRejection", (reason, promise) => {
  logger(`⚠️ Global Unhandled Rejection at: ${promise} reason: ${reason}`);
});

// -------------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------------
async function main() {
  logger("====================================================");
  logger("🤖 Aave V3 Flashbots Bundle Liquidator (Back4app Ready)");
  logger(`Deployer Wallet: ${wallet.address}`);
  logger(`Contract:        ${FLASH_LIQUIDATOR_ADDRESS}`);
  logger(`Flashbots Relay: ${FLASHBOTS_RELAY_URL}`);
  logger("====================================================\n");

  loadCachedBorrowers();
  await syncGasAndNonce();
  
  triggerBackgroundFullScan();
  setInterval(syncGasAndNonce, 10000);

  initWebSocketClient();
}

main().catch((err) => logger(`Fatal startup error: ${err.message || err}`));