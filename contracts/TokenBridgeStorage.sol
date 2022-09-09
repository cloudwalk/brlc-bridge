// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { ITokenBridgeTypes } from "./interfaces/ITokenBridge.sol";

/**
 * @title TokenBridge storage version 1
 * @dev See terms in the comments of the {ITokenBridge} interface.
 */
abstract contract TokenBridgeStorageV1 is ITokenBridgeTypes {
    /// @dev The address of the underlying token contract whose coins are being relocated.
    address internal _token;

    /// @dev The mapping: a destination chain ID => the number of pending relocations to that chain.
    mapping(uint256 => uint256) internal _pendingRelocationCounters;

    /// @dev The mapping: a destination chain ID => the nonce of the last processed relocation to that chain.
    mapping(uint256 => uint256) internal _lastProcessedRelocationNonces;

    /// @dev The mapping: a destination chain ID => the mode of relocation to that chain.
    mapping(uint256 => OperationMode) internal _relocationModes;

    /// @dev The mapping: a destination chain ID, a nonce => the relocation structure matching to that chain and nonce.
    mapping(uint256 => mapping(uint256 => Relocation)) internal _relocations;

    /// @dev The mapping: a source chain ID => the mode of accommodation from that chain.
    mapping(uint256 => OperationMode) internal _accommodationModes;

    /// @dev The mapping: a source chain ID => the nonce of the last accommodation from that chain.
    mapping(uint256 => uint256) internal _lastAccommodationNonces;
}

/**
 * @title TokenBridge storage
 * @dev Contains storage variables of the single token bridge contract.
 *
 * We are following Compound's approach of upgrading new contract implementations.
 * See https://github.com/compound-finance/compound-protocol.
 * When we need to add new storage variables, we create a new version of TokenBridgeStorage
 * e.g. TokenBridgeStorage<versionNumber>, so finally it would look like
 * "contract TokenBridgeStorage is TokenBridgeStorageV1, TokenBridgeStorageV2".
 */
abstract contract TokenBridgeStorage is TokenBridgeStorageV1 {

}
