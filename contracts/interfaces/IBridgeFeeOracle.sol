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
     * @param chainId The ID of a destination chain of the bridge operation.
     * @param token The address of a token to bridge.
     * @param account An owner of tokens to bridge.
     * @param amount An amount of tokens to bridge
     */
    function defineFee(
        uint256 chainId,
        address token,
        address account,
        uint256 amount
    ) external view returns (uint256);
}
