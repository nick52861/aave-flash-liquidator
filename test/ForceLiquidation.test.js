import { expect } from "chai";
import hre from "hardhat";

const { ethers, network } = hre;

describe("Force Liquidation on Base Mainnet Fork", function () {
  this.timeout(120000);

  // Protocol Addresses on Base Mainnet
  const AAVE_POOL_ADDRESSES_PROVIDER = ethers.getAddress("0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d".toLowerCase());
  const AAVE_POOL = ethers.getAddress("0xa238dd80c259a72e81d7e4664a9801593F98d1c5".toLowerCase());
  const BALANCER_VAULT = ethers.getAddress("0xba12222222228d8ba445958a75a0704d566bf2c8".toLowerCase());
  const SWAP_ROUTER = ethers.getAddress("0x2626664c2603336e57b271c5c0b26f421741e481".toLowerCase());

  // Tokens on Base
  const WETH = ethers.getAddress("0x4200000000000000000000000000000000000006".toLowerCase());
  const USDC = ethers.getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".toLowerCase());

  // ABIs
  const POOL_ABI = [
    "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external",
    "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external"
  ];

  const PROVIDER_ABI = ["function getPriceOracle() external view returns (address)"];
  const ORACLE_ABI = [
    "function getAssetPrice(address asset) external view returns (uint256)",
    "function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)"
  ];

  const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)"
  ];

  const WETH_ABI = [
    "function deposit() external payable",
    "function approve(address spender, uint256 amount) external returns (bool)"
  ];

  let deployer;
  let borrower;
  let pool;
  let oracle;
  let oracleAddress;

  before(async function () {
    await ethers.provider.send("evm_mine", []);
    [deployer, borrower] = await ethers.getSigners();

    pool = await ethers.getContractAt(POOL_ABI, AAVE_POOL);

    const provider = await ethers.getContractAt(PROVIDER_ABI, AAVE_POOL_ADDRESSES_PROVIDER);
    const rawOracleAddr = await provider.getPriceOracle();
    oracleAddress = ethers.getAddress(rawOracleAddr.toLowerCase());
    oracle = await ethers.getContractAt(ORACLE_ABI, oracleAddress);

    console.log(`\n📌 Resolved Aave Oracle Address: ${oracleAddress}`);

    // 1. Convert native ETH to WETH for Borrower
    const wethContract = await ethers.getContractAt(WETH_ABI, WETH);
    const wethDepositAmount = ethers.parseEther("10.0"); // 10 WETH (~$18,900)
    await wethContract.connect(borrower).deposit({ value: wethDepositAmount });

    // 2. Supply 10 WETH as Collateral
    await wethContract.connect(borrower).approve(AAVE_POOL, wethDepositAmount);
    await pool.connect(borrower).supply(WETH, wethDepositAmount, borrower.address, 0);

    // 3. Borrow 10,000 USDC Debt
    const usdcBorrowAmount = ethers.parseUnits("10000", 6); // 10,000 USDC
    await pool.connect(borrower).borrow(USDC, usdcBorrowAmount, 2, 0, borrower.address);

    const initialData = await pool.getUserAccountData(borrower.address);
    const initialHF = Number(initialData.healthFactor) / 1e18;

    console.log(`\n👤 Borrower Position Created:`);
    console.log(`   Collateral: 10.0 WETH (~$18,900)`);
    console.log(`   Debt: 10,000.00 USDC`);
    console.log(`📊 Initial Borrower Health Factor: ${initialHF.toFixed(4)}`);
  });

  it("Should force HF < 1.0 and execute FlashLiquidation", async function () {
    // 1. Override Aave Oracle with Mock Oracle
    const TEMP_REAL_ORACLE = "0x1111111111111111111111111111111111111111";
    const realOracleBytecode = await ethers.provider.getCode(oracleAddress);
    await network.provider.send("hardhat_setCode", [TEMP_REAL_ORACLE, realOracleBytecode]);

    const MockOracleFactory = await ethers.getContractFactory("MockAaveOracle");
    const mockOracle = await MockOracleFactory.deploy(TEMP_REAL_ORACLE);
    await mockOracle.waitForDeployment();

    const mockBytecode = await ethers.provider.getCode(await mockOracle.getAddress());
    await network.provider.send("hardhat_setCode", [oracleAddress, mockBytecode]);

    console.log("\n🛠️ Overrode Aave Oracle with Mock Oracle");

    const mockOracleContract = await ethers.getContractAt(
      ["function setAssetPrice(address asset, uint256 price) external"],
      oracleAddress
    );

    // 2. Adjust WETH Price to $1,200 (Drops HF to ~0.99)
    const manipulatedWethPrice = 1200n * 10n ** 8n; // $1,200 in 8 decimals
    await mockOracleContract.setAssetPrice(WETH, manipulatedWethPrice);

    const updatedData = await pool.getUserAccountData(borrower.address);
    const newHF = Number(updatedData.healthFactor) / 1e18;
    console.log(`📉 Adjusted WETH Price to $1,200.00`);
    console.log(`⚠️ New Borrower Health Factor: ${newHF.toFixed(4)}`);

    expect(newHF).to.be.below(1.0);

    // 3. Deploy Liquidator Contract
    const Liquidator = await ethers.getContractFactory("FlashLiquidation");
    const liquidator = await Liquidator.deploy(BALANCER_VAULT, AAVE_POOL, SWAP_ROUTER);
    await liquidator.waitForDeployment();
    console.log(`\n🚀 FlashLiquidation Deployed to Fork at: ${await liquidator.getAddress()}`);

    const usdcContract = await ethers.getContractAt(ERC20_ABI, USDC);
    const balanceBefore = await usdcContract.balanceOf(deployer.address);

    // 4. Liquidate 5,000 USDC debt using 0.05% Uniswap Pool (fee = 500)
    const debtToCoverUsdc = ethers.parseUnits("5000", 6);
    console.log(`⚡ Executing Flash Liquidation for ${ethers.formatUnits(debtToCoverUsdc, 6)} USDC...`);

    const tx = await liquidator.executeFlashLiquidation(
      WETH,               // Collateral to receive
      USDC,               // Debt to repay
      borrower.address,   // Insolvent user
      debtToCoverUsdc,    // 5,000 USDC
      500                 // Uniswap Pool Fee (500 = 0.05%)
    );

    const receipt = await tx.wait();
    console.log(`✅ Liquidation Transaction Succeeded! Gas Used: ${receipt.gasUsed.toString()}`);

    // 5. Verify Net USDC Profit
    const balanceAfter = await usdcContract.balanceOf(deployer.address);
    const profit = balanceAfter - balanceBefore;
    console.log(`🎉 Net Profit Transferred to Deployer: +$${(Number(profit) / 1e6).toFixed(2)} USDC`);

    expect(profit).to.be.above(0n);
  });
});