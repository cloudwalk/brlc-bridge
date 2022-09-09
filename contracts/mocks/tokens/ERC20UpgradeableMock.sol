// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import { IERC20Bridgeable } from "../../interfaces/IERC20Bridgeable.sol";

/**
 * @title ERC20UpgradeableMock contract
 * @dev An implementation of the {ERC20Upgradeable} contract for test purposes.
 */
contract ERC20UpgradeableMock is ERC20Upgradeable, IERC20Bridgeable {
    address private _bridge;
    bool private _isMintingForBridgingDisabled;
    bool private _isBurningForBridgingDisabled;

    /**
     * @dev The initialize function of the upgradable contract.
     * @param name_ The name of the token to set for this ERC20-comparable contract.
     * @param symbol_ The symbol of the token to set for this ERC20-comparable contract.
     */
    function initialize(string memory name_, string memory symbol_) public initializer {
        __ERC20_init(name_, symbol_);
    }

    /**
     * @dev Cals the appropriate internal function to mint needed amount of tokens for an account.
     * @param account The address of an account to mint for.
     * @param amount The amount of tokens to mint.
     */
    function mint(address account, uint256 amount) external returns (bool) {
        _mint(account, amount);
        return true;
    }

    /// @dev See {IERC20Bridgeable-mintForBridging}.
    function mintForBridging(address account, uint256 amount) external override returns (bool) {
        if (_isMintingForBridgingDisabled) {
            return false;
        }
        _mint(account, amount);
        emit MintForBridging(account, amount);
        return true;
    }

    /// @dev See {IERC20Bridgeable-burnForBridging}.
    function burnForBridging(address account, uint256 amount) external override returns (bool) {
        if (_isBurningForBridgingDisabled) {
            return false;
        }
        _burn(msg.sender, amount);
        emit BurnForBridging(account, amount);
        return true;
    }

    /// @dev See {IERC20Bridgeable-isBridgeSupported}.
    function isBridgeSupported(address bridge) public view override returns (bool) {
        return (bridge != address(0)) && (_bridge == bridge);
    }

    /// @dev See {IERC20Bridgeable-isIERC20Bridgeable}.
    function isIERC20Bridgeable() public pure override returns (bool) {
        return true;
    }

    /**
     * @dev Sets the address of the bridge.
     * @param newBridge The address of the new bridge.
     */
    function setBridge(address newBridge) external {
        _bridge = newBridge;
    }

    /// @dev Disables token minting for bridging operations.
    function disableMintingForBridging() external {
        _isMintingForBridgingDisabled = true;
    }

    /// @dev Disables token burning for bridging operations.
    function disableBurningForBridging() external {
        _isBurningForBridgingDisabled = true;
    }
}
