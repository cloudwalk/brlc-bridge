// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IBridgeGuard } from "../interfaces/IBridgeGuard.sol";

/**
 * @title BridgeGuard mock contract
 * @dev An implementation of the {IBridgeGuard} interface for test purposes.
 */
contract BridgeGuardMock is IBridgeGuard {
    /// @dev The result of the `validateAccommodation()` function call.
    uint256 public validationError;

    /**
     * @dev The constructor that simply calls unused stub functions to provide 100% coverage.
     */
    constructor() {
        configureAccommodationGuard(0, address(0), 0, 0);
    }

    /// @dev Sets a new value for the result of the `validateAccommodation()` function.
    function setValidationError(uint256 newValidationError) external {
        validationError = newValidationError;
    }

    /**
     * @dev See {IBridgeGuard-validateAccommodation}.
     *
     * Returns the previously set validation error.
     */
    function validateAccommodation(
        uint256 chainId,
        address token,
        address account,
        uint256 amount
    ) external view returns (uint256) {
        // Silences a compiler warning about the unused parameter.
        chainId;
        token;
        account;
        amount;

        return validationError;
    }

    /**
     * @dev See {IBridgeGuard-configureAccommodationGuard}
     *
     * Just a stub for testing. Does nothing.
     */
    function configureAccommodationGuard(
        uint256 chainId,
        address token,
        uint256 newTimeFrame,
        uint256 newVolumeLimit
    ) public pure {
        // Silences a compiler warning about the unused parameter.
        chainId;
        token;
        newTimeFrame;
        newVolumeLimit;
    }
}
