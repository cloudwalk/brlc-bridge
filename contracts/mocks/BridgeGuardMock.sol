// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IBridgeGuard } from "../interfaces/IBridgeGuard.sol";

/**
 * @title BridgeFeeOracleMock contract
 * @author CloudWalk Inc.
 * @dev An implementation of the {IBridgeFeeOracle} contract for test purposes.
 */
contract BridgeGuardMock is IBridgeGuard {
    /// @dev The counter of calls for the `registerAndCheckAccommodation` function.
    uint256 internal _callCounter;

    /// @dev The limit of calls for the `registerAndCheckAccommodation` function.
    uint256 internal _callCounterLimit;

    /// @dev The error code to return from the `registerAndCheckAccommodation` function.
    uint256 internal _errorCode;

    /**
     * @dev See {IBridgeGuard-registerAndCheckAccommodation}.
     *
     * Simulates the call of the appropriate {IBridgeGuard} interface function by counting the calls.
     * If the number of calls is less than the {_callCounterLimit} value returns zero,
     * otherwise returns the {_errorCode} value.
     */
    function registerAndCheckAccommodation(
        uint256 chainId,
        address token,
        address account,
        uint256 amount
    ) external returns (uint256 errorCode) {
        chainId;
        token;
        account;
        amount;

        errorCode = 0;

        uint256 callCounter = _callCounter + 1;
        if (callCounter >= _callCounterLimit) {
            errorCode = _errorCode;
        }
        _callCounter = callCounter;
    }

    /// @dev Configures the appropriate internal storage values.
    function configure(uint256 callCounterLimit, uint256 errorCode) external {
        _callCounterLimit = callCounterLimit;
        _errorCode = errorCode;
    }
}
