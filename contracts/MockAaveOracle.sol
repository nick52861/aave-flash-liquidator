// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
    function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory);
}

contract MockAaveOracle {
    address public immutable REAL_ORACLE;
    mapping(address => uint256) public customPrices;

    constructor(address _realOracle) {
        REAL_ORACLE = _realOracle;
    }

    function setAssetPrice(address asset, uint256 price) external {
        customPrices[asset] = price;
    }

    // 💡 Changed from 'external' to 'public' so it can be called internally
    function getAssetPrice(address asset) public view returns (uint256) {
        if (customPrices[asset] > 0) {
            return customPrices[asset];
        }
        return IAaveOracle(REAL_ORACLE).getAssetPrice(asset);
    }

    // Batch asset lookup used internally by Aave Pool liquidationCall
    function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory) {
        uint256[] memory prices = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            prices[i] = getAssetPrice(assets[i]);
        }
        return prices;
    }
}