// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title BridgeFeeOracle interface
 * @author CloudWalk Inc.
 * @dev The interface of an oracle to define bridge operation fees.
 */
interface IBridgeFeeOracle {
    /**
     * @dev Defines a fee for a bridge operation.
     * @param chainId A destination chain ID of the bridge operation.
     * @param token The address of a token that involved in the bridge operation.
     * @param account An account that requested the bridge operation.
     * @param amount An amount of tokens to transfer with the bridge operation.
     */
    function defineFee(
        uint256 chainId,
        address token,
        address account,
        uint256 amount
    ) external view returns (uint256);
}
