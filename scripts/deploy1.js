import hre from "hardhat";

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("\n====================================================");
  console.log(`🚀 Deploying FlashLiquidation contract`);
  console.log(`Deployer Address: ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer Balance: ${hre.ethers.formatEther(balance)} ETH`);
  console.log("====================================================\n");

  // -------------------------------------------------------------------
  // BASE MAINNET PROTOCOL ADDRESSES
  // -------------------------------------------------------------------
  const CONFIG = {
    balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", // Balancer V2 Vault
    aavePool:      "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Aave V3 Pool
    swapRouter:    "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap V3 SwapRouter
  };

  console.log("Configured Addresses:");
  console.log(` - Balancer Vault: ${CONFIG.balancerVault}`);
  console.log(` - Aave V3 Pool:   ${CONFIG.aavePool}`);
  console.log(` - Swap Router:    ${CONFIG.swapRouter}\n`);

  const FlashLiquidation = await hre.ethers.getContractFactory("FlashLiquidation");

  console.log("Sending deployment transaction to Base Mainnet...");
  const flashLiquidation = await FlashLiquidation.deploy(
    CONFIG.balancerVault,
    CONFIG.aavePool,
    CONFIG.swapRouter
  );

  await flashLiquidation.waitForDeployment();
  const deployedAddress = await flashLiquidation.getAddress();

  console.log("\n====================================================");
  console.log(`✅ FlashLiquidation successfully deployed to Base Mainnet!`);
  console.log(`   Contract Address: ${deployedAddress}`);
  console.log("====================================================\n");

  console.log("📌 Copy this address into your bot.js script!");
  console.log("\n(Optional) To verify this contract on Basescan, run:");
  console.log(
    `npx hardhat verify --network base ${deployedAddress} "${CONFIG.balancerVault}" "${CONFIG.aavePool}" "${CONFIG.swapRouter}"\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});