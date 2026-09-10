import { parentPort, workerData } from "worker_threads";
import { ethers } from "ethers";

const { rpcUrl, poolAddress, multicallAddress, targets } = workerData;

const CHUNK_SIZE = 150; // Safer chunk size to avoid RPC byte limits

const provider = new ethers.JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });

// ABIs
const poolInterface = new ethers.Interface([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
]);

const multicallInterface = new ethers.Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)"
]);

// Pre-build call structs for every target
const precalculatedCalls = targets.map((user) => ({
  target: poolAddress,
  allowFailure: true,
  callData: poolInterface.encodeFunctionData("getUserAccountData", [user])
}));

// -------------------------------------------------------------------
// CHUNK PROCESSOR
// -------------------------------------------------------------------
async function auditChunk(userChunk, callChunk) {
  const highRiskTargets = [];

  try {
    const calldataHex = multicallInterface.encodeFunctionData("aggregate3", [callChunk]);

    const rawHexResult = await provider.call({
      to: multicallAddress,
      data: calldataHex,
    });

    if (!rawHexResult || rawHexResult === "0x") return highRiskTargets;

    const decoded = multicallInterface.decodeFunctionResult("aggregate3", rawHexResult);
    const results = decoded[0];

    for (let i = 0; i < results.length; i++) {
      const { success, returnData } = results[i];
      if (!success || returnData === "0x") continue;

      const user = userChunk[i];
      const parsedData = poolInterface.decodeFunctionResult("getUserAccountData", returnData);

      const totalDebtUSD = Number(parsedData.totalDebtBase) / 1e8;
      const healthFactor = Number(parsedData.healthFactor) / 1e18;

      // Include active debt positions with Health Factor < 10.0 or near insolvency
      // (If HF is uint256 max / infinity, healthFactor will be > 1e10)
      if (totalDebtUSD > 1.0 && healthFactor < 10.0) {
        highRiskTargets.push({
          address: user,
          healthFactor,
          totalDebtUSD,
        });
      }
    }
  } catch (err) {
    // Ignore RPC failure per chunk
  }

  return highRiskTargets;
}

// -------------------------------------------------------------------
// EXECUTION ENTRYPOINT
// -------------------------------------------------------------------
async function runFullScan() {
  const startTime = Date.now();
  const chunkPromises = [];

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const userChunk = targets.slice(i, i + CHUNK_SIZE);
    const callChunk = precalculatedCalls.slice(i, i + CHUNK_SIZE);
    chunkPromises.push(auditChunk(userChunk, callChunk));
  }

  const results = await Promise.all(chunkPromises);
  const flattened = results.flat();

  // Sort targets by lowest Health Factor (highest risk first)
  const highRiskWatchlist = flattened
    .sort((a, b) => a.healthFactor - b.healthFactor)
    .map((item) => item.address);

  const duration = Date.now() - startTime;

  parentPort.postMessage({
    watchlist: highRiskWatchlist,
    durationMs: duration,
    scannedCount: targets.length,
    activePositionsFound: flattened.length
  });
}

runFullScan().catch((err) => {
  parentPort.postMessage({ watchlist: [], error: err.message });
});