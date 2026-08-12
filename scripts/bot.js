import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();
import express from "express";

// -------------------------------------------------------------------
// KEEP-ALIVE HTTP SERVER FOR RENDER & UPTIMEROBOT
// -------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🤖 Aave V3 Liquidation Bot is active and monitoring Base blocks!");
});

app.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// -------------------------------------------------------------------
// CONFIGURATION & CONSTANTS
// -------------------------------------------------------------------
const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

let contractAddr = process.env.CONTRACT_ADDRESS || "0x82F3F2f5F53E31BeB69F6c51298cB708e993b3aB";
if (contractAddr.startsWith("0x0x")) {
  contractAddr = contractAddr.replace("0x0x", "0x");
}
const FLASH_LIQUIDATOR_ADDRESS = contractAddr;

const POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"; // Aave V3 Base Pool
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // WETH
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11"; // Multicall3 on Base

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// -------------------------------------------------------------------
// ABIS
// -------------------------------------------------------------------
const POOL_ABI = [
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
];

const MULTICALL_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[] returnData)"
];

const FLASH_LIQUIDATOR_ABI = [
  "function executeFlashLiquidation(address collateralAsset, address debtAsset, address targetUser, uint256 debtToCover, uint24 poolFee) external",
  "function withdrawToken(address tokenAddress) external",
  "function withdrawETH() external"
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)"
];

// Contract Instances
const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);
const multicallContract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL_ABI, provider);
const liquidatorContract = new ethers.Contract(FLASH_LIQUIDATOR_ADDRESS, FLASH_LIQUIDATOR_ABI, wallet);
const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

// State Management
const targetUsers = new Set();
const pendingLiquidations = new Set();
let lastScannedBlock = 0;
let isScanning = false; // Concurrency lock for rapid Base block ticks

// -------------------------------------------------------------------
// BORROWER INDEXING
// -------------------------------------------------------------------
async function fetchRecentBorrowers() {
  console.log("🔄 Indexing recent Aave V3 borrowers on Base...");
  try {
    const currentBlock = await provider.getBlockNumber();
    lastScannedBlock = currentBlock;
    
    const fromBlock = Math.max(0, currentBlock - 1500); // ~1 hour lookback
    const borrowEvents = await pool.queryFilter(pool.filters.Borrow(), fromBlock, currentBlock);
    
    borrowEvents.forEach(event => {
      const user = event.args.onBehalfOf || event.args.user;
      if (user) targetUsers.add(user);
    });

    console.log(`✅ Loaded ${targetUsers.size} unique active borrowers into queue.\n`);
  } catch (err) {
    console.warn("⚠️ Historical indexing notice:", err.message);
  }
}

async function checkForNewBorrowers() {
  try {
    const currentBlock = await provider.getBlockNumber();
    if (currentBlock <= lastScannedBlock) return;

    const newEvents = await pool.queryFilter(pool.filters.Borrow(), lastScannedBlock + 1, currentBlock);
    newEvents.forEach(event => {
      const borrower = event.args.onBehalfOf || event.args.user;
      if (borrower && !targetUsers.has(borrower)) {
        targetUsers.add(borrower);
        console.log(`⚡ Real-time borrower detected: ${borrower}`);
      }
    });

    lastScannedBlock = currentBlock;
  } catch (err) {}
}

// -------------------------------------------------------------------
// FLASH LOAN EXECUTION ENGINE WITH PROFIT TRACKING
// -------------------------------------------------------------------
async function executeLiquidation(targetUser, healthFactor, totalDebtUSD) {
  if (pendingLiquidations.has(targetUser)) return;
  pendingLiquidations.add(targetUser);

  try {
    console.log(`\n====================================================`);
    console.log(`🚨 UNHEALTHY POSITION DETECTED!`);
    console.log(`User: ${targetUser} | HF: ${healthFactor.toFixed(4)}`);
    console.log(`====================================================`);

    // Record initial deployer USDC balance
    const initialUsdcBalance = await usdcContract.balanceOf(wallet.address);

    const closeFactor = healthFactor > 0.95 ? 0.50 : 1.00;
    const targetDebtUSD = totalDebtUSD * closeFactor;
    const debtToCover = ethers.parseUnits(targetDebtUSD.toFixed(6), 6);
    const UNISWAP_V3_FEE = 500; // 0.05% Pool Fee

    const feeData = await provider.getFeeData();

    const tx = await liquidatorContract.executeFlashLiquidation(
      WETH_ADDRESS,
      USDC_ADDRESS,
      targetUser,
      debtToCover,
      UNISWAP_V3_FEE,
      {
        gasLimit: 800000,
        maxFeePerGas: feeData.maxFeePerGas ? (feeData.maxFeePerGas * 120n) / 100n : undefined,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * 120n) / 100n : undefined,
      }
    );

    console.log(`🚀 Transaction Submitted: https://basescan.org/tx/${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Flash Liquidation Confirmed in Block #${receipt.blockNumber}`);

    // Check new USDC balance & log net profit credited to deployer
    const finalUsdcBalance = await usdcContract.balanceOf(wallet.address);
    const profitMade = finalUsdcBalance - initialUsdcBalance;

    if (profitMade > 0n) {
      console.log(`💰 PROFIT CREDITED TO DEPLOYER: +$${ethers.formatUnits(profitMade, 6)} USDC 🎉`);
    } else {
      console.log(`ℹ️ Check Basescan for contract token balances.`);
    }

  } catch (error) {
    console.error(`❌ Liquidation Failed:`, error.reason || error.message);
  } finally {
    pendingLiquidations.delete(targetUser);
  }
}

// -------------------------------------------------------------------
// HEALTH FACTOR MONITORING (MULTICALL3 BATCHED & BLOCK DRIVEN)
// -------------------------------------------------------------------
async function scanBorrowers(blockNumber) {
  // Concurrency Guard: Skip if previous scan is still processing
  if (isScanning || targetUsers.size === 0) return;
  isScanning = true;

  try {
    const usersArray = Array.from(targetUsers);
    console.log(`📦 [Block #${blockNumber}] Scanning ${usersArray.length} active borrowers via Multicall3...`);

    const BATCH_SIZE = 100; // Batch up to 100 queries per single RPC call

    for (let i = 0; i < usersArray.length; i += BATCH_SIZE) {
      const batch = usersArray.slice(i, i + BATCH_SIZE);

      // Encode calls into Multicall aggregate3 format
      const calls = batch.map((user) => ({
        target: POOL_ADDRESS,
        allowFailure: true,
        callData: pool.interface.encodeFunctionData("getUserAccountData", [user])
      }));

      // Execute batched static call
      const results = await multicallContract.aggregate3.staticCall(calls);

      for (let j = 0; j < results.length; j++) {
        const { success, returnData } = results[j];
        if (!success || returnData === "0x") continue;

        const user = batch[j];
        const decoded = pool.interface.decodeFunctionResult("getUserAccountData", returnData);

        const totalCollateralUSD = Number(decoded.totalCollateralBase) / 1e8;
        const totalDebtUSD = Number(decoded.totalDebtBase) / 1e8;
        const healthFactor = Number(decoded.healthFactor) / 1e18;

        if (totalDebtUSD > 10) {
          if (healthFactor < 1.0) {
            console.log(`🚨 INSOLVENT TARGET FOUND: ${user} | Collateral: $${totalCollateralUSD.toFixed(2)} | Debt: $${totalDebtUSD.toFixed(2)} | HF: ${healthFactor.toFixed(4)}`);
            await executeLiquidation(user, healthFactor, totalDebtUSD);
          }
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ Multicall scan error:", err.message);
  } finally {
    isScanning = false; // Release lock
  }
}

// -------------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------------
async function main() {
  console.log("====================================================");
  console.log("🤖 Aave V3 Zero-Fee Flash Loan Liquidation Bot");
  console.log(`Deployer Wallet: ${wallet.address}`);
  console.log(`Contract:        ${FLASH_LIQUIDATOR_ADDRESS}`);
  console.log("====================================================\n");

  await fetchRecentBorrowers();

  // Periodically update active borrower queue
  setInterval(checkForNewBorrowers, 10000);

  // Trigger scanning immediately on every new Base block (~2 seconds)
  provider.on("block", async (blockNumber) => {
    await scanBorrowers(blockNumber);
  });
}

main().catch(console.error);