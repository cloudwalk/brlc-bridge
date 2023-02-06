// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IBridgeFeeOracle } from "../interfaces/IBridgeFeeOracle.sol";

/**
 * @title BridgeFeeOracleMock contract
 * @author CloudWalk Inc.
 * @dev An implementation of the {IBridgeFeeOracle} contract for test purposes.
 */
contract BridgeFeeOracleMock is IBridgeFeeOracle {
    /**
     * @dev See {ConstantBridgeFeeOracle-feeOracle}.
     *
     * Always returns 0.1 of the `amount`.
     */
    function defineFee(
        uint256 chainId,
        address token,
        address account,
        uint256 amount
    ) external pure returns (uint256) {
        chainId;
        token;
        account;

        return amount / 10;
    }
}
