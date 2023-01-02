// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { PauseControlUpgradeable } from "@cloudwalk-inc/brlc-contracts/contracts/base/PauseControlUpgradeable.sol";

/**
 * @title PauseControlUpgradeableMock contract
 * @author CloudWalk Inc.
 * @dev An implementation of the {PauseControlUpgradeable} contract for test purposes.
 */
contract PauseControlUpgradeableMock is PauseControlUpgradeable {
    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /**
     * @dev The initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable .
     */
    function initialize() public initializer {
        _setupRole(OWNER_ROLE, _msgSender());
        __PauseControl_init(OWNER_ROLE);
    }

    /**
     * @dev To check that the initialize function of the ancestor contract has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize() public {
        __PauseControl_init(OWNER_ROLE);
    }

    /**
     * @dev To check that the unchained initialize function of the ancestor contract
     * has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize_unchained() public {
        __PauseControl_init_unchained(OWNER_ROLE);
    }
}
