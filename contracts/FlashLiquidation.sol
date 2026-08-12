// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// --- Balancer V2 Interfaces ---
interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IBalancerVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

// --- Aave V3 Pool Interface ---
interface IPool {
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

// --- Uniswap V3 SwapRouter02 Interface (Base Mainnet) ---
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        // Note: SwapRouter02 on Base omits the `deadline` field
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract FlashLiquidation is IFlashLoanRecipient, Ownable {
    IBalancerVault public immutable balancerVault;
    IPool public immutable aavePool;
    ISwapRouter public immutable swapRouter;

    struct LiquidationParams {
        address collateralAsset;
        address debtAsset;
        address targetUser;
        uint24 poolFee;
    }

    /// @param _balancerVault Base Balancer Vault (0xBA12222222228d8Ba445958a75a0704d566BF2C8)
    /// @param _aavePool Base Aave V3 Pool (0xA238Dd80C259a72e81d7e4664a9801593F98d1c5)
    /// @param _swapRouter Base Uniswap V3 SwapRouter02 (0x2626664c2603336E57B271c5C0b26F421741e481)
    constructor(
        address _balancerVault,
        address _aavePool,
        address _swapRouter
    ) Ownable(msg.sender) {
        balancerVault = IBalancerVault(_balancerVault);
        aavePool = IPool(_aavePool);
        swapRouter = ISwapRouter(_swapRouter);
    }

    /// @notice Triggers zero-fee flash loan liquidation via Balancer
    function executeFlashLiquidation(
        address collateralAsset,
        address debtAsset,
        address targetUser,
        uint256 debtToCover,
        uint24 poolFee
    ) external onlyOwner {
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(debtAsset);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = debtToCover;

        bytes memory userData = abi.encode(
            LiquidationParams({
                collateralAsset: collateralAsset,
                debtAsset: debtAsset,
                targetUser: targetUser,
                poolFee: poolFee
            })
        );

        // 1. Request Flash Loan from Balancer Vault
        balancerVault.flashLoan(this, tokens, amounts, userData);
    }

    /// @notice Callback function executed by Balancer Vault during flash loan
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(balancerVault), "Caller must be Balancer Vault");

        LiquidationParams memory params = abi.decode(userData, (LiquidationParams));
        IERC20 debtToken = tokens[0];
        uint256 debtAmount = amounts[0];
        uint256 feeAmount = feeAmounts[0];

        // 1. Approve Aave Pool to spend debt token for liquidation
        debtToken.approve(address(aavePool), debtAmount);

        // 2. Perform Liquidation on Aave V3
        aavePool.liquidationCall(
            params.collateralAsset,
            params.debtAsset,
            params.targetUser,
            debtAmount,
            false // Receive underlying collateral asset directly (e.g., WETH), not aTokens
        );

        // 3. Swap collateral received (WETH) for debt token (USDC) on Uniswap V3
        IERC20 collateralToken = IERC20(params.collateralAsset);
        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        collateralToken.approve(address(swapRouter), collateralBalance);

        uint256 totalAmountOwed = debtAmount + feeAmount;

        // Form parameters matching SwapRouter02 specification
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: params.collateralAsset,
            tokenOut: params.debtAsset,
            fee: params.poolFee, // e.g., 500 = 0.05%
            recipient: address(this),
            amountIn: collateralBalance,
            amountOutMinimum: totalAmountOwed, // Guarantees liquidation profitability
            sqrtPriceLimitX96: 0
        });

        swapRouter.exactInputSingle(swapParams);

        // 4. Repay Balancer Vault directly
        debtToken.transfer(address(balancerVault), totalAmountOwed);

        // 5. Transfer remaining net profit (debt token) to owner
        uint256 profitDebt = debtToken.balanceOf(address(this));
        if (profitDebt > 0) {
            debtToken.transfer(owner(), profitDebt);
        }

        // 6. Transfer any leftover collateral token to owner
        uint256 leftoverCollateral = collateralToken.balanceOf(address(this));
        if (leftoverCollateral > 0) {
            collateralToken.transfer(owner(), leftoverCollateral);
        }
    }

    /// @notice Withdraw any ERC20 token accumulated in the contract to the owner
    function withdrawToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No token balance");
        IERC20(token).transfer(owner(), balance);
    }

    /// @notice Withdraw native ETH accumulated in the contract to the owner
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH balance");
        (bool success, ) = owner().call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    /// @notice Receive native ETH
    receive() external payable {}
}