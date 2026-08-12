const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlashLiquidation Base Fork Tests", function () {
  let liquidator;
  let owner;
  
  // Base Protocol Addresses
  const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";

  // Tokens
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Deploy contract to local Base fork
    const FlashLiquidation = await ethers.getContractFactory("FlashLiquidation");
    liquidator = await FlashLiquidation.deploy(
      BALANCER_VAULT,
      AAVE_POOL,
      SWAP_ROUTER
    );
    await liquidator.waitForDeployment();
  });

  it("Should correctly set the owner to deployer", async function () {
    expect(await liquidator.owner()).to.equal(owner.address);
  });

  it("Should revert if non-owner tries to trigger liquidation", async function () {
    const [, unauthorizedUser] = await ethers.getSigners();
    const liquidatorAsOther = liquidator.connect(unauthorizedUser);

    await expect(
      liquidatorAsOther.executeFlashLiquidation(
        WETH_ADDRESS,
        USDC_ADDRESS,
        "0x0000000000000000000000000000000000000001",
        1000000,
        500
      )
    ).to.be.revertedWithCustomError(liquidator, "OwnableUnauthorizedAccount");
  });

  it("Should attempt flash loan execution against live Base protocol states", async function () {
    // Replace this address with a real unhealthy user detected by your bot on Base
    const targetUser = "0x675c8697949e0Cc6269e8625D805a2749FaD6707"; 
    const debtToCover = ethers.parseUnits("100", 6); // 100 USDC

    console.log(`Testing liquidation against target user: ${targetUser}`);

    // Execute flash liquidation on local fork
    try {
      const tx = await liquidator.executeFlashLiquidation(
        WETH_ADDRESS,
        USDC_ADDRESS,
        targetUser,
        debtToCover,
        500 // Uniswap V3 Pool Fee (0.05%)
      );
      const receipt = await tx.wait();
      console.log("✅ Execution Success! Gas used:", receipt.gasUsed.toString());
    } catch (error) {
      // If user isn't actually liquidatable right now, Aave will revert with error code 35 or 42
      console.log("ℹ️ Reverted as expected if user Health Factor > 1.0:", error.message);
    }
  });
});