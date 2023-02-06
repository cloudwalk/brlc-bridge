// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title BridgeGuard interface
 * @author CloudWalk Inc.
 * @dev The interface of a bridge guard contract
 */
interface IBridgeGuard {
    /**
     * @dev Registers a new accommodation bridge operation and checks that it is secure.
     * @param chainId A source chain ID of the bridge operation.
     * @param token The address of a token that involved in the bridge operation.
     * @param account An account that requested the bridge operation.
     * @param amount An amount of tokens to transfer with the bridge operation.
     * @return errorCode The zero value if the operation is secure or non-zero code that identifies an error.
     */
    function registerAndCheckAccommodation(
        uint256 chainId,
        address token,
        address account,
        uint256 amount
    ) external returns (uint256 errorCode);
}
