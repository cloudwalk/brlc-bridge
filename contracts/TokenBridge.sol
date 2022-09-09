// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IERC20Bridgeable } from "./interfaces/IERC20Bridgeable.sol";
import { ITokenBridge } from "./interfaces/ITokenBridge.sol";
import { TokenBridgeStorage } from "./TokenBridgeStorage.sol";
import { PauseControlUpgradeable } from "./base/PauseControlUpgradeable.sol";
import { RescueControlUpgradeable } from "./base/RescueControlUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder.sol";

/**
 * @title TokenBridgeUpgradeable contract
 * @dev Allows to bridge coins of a single token contract between blockchains.
 * See terms in the comments of the {ITokenBridge} interface.
 */
contract TokenBridge is
    AccessControlUpgradeable,
    PauseControlUpgradeable,
    RescueControlUpgradeable,
    StoragePlaceholder200,
    TokenBridgeStorage,
    ITokenBridge
{
    /// @dev The contract owner role.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role who is allowed to execute bridge operations.
    bytes32 public constant BRIDGER_ROLE = keccak256("BRIDGER_ROLE");

    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -------------------- Events -----------------------------------

    /// @dev Emitted when the mode of relocation to a specified chain is changed.
    event SetRelocationMode(
        uint256 indexed chainId, // The destination chain ID of the relocation.
        OperationMode oldMode,   // The old mode of the relocation.
        OperationMode newMode    // The new mode of the relocation.
    );

    /// @dev Emitted when mode of accommodation from a specified chain is changed.
    event SetAccommodationMode(
        uint256 indexed chainId, // The source chain ID of the accommodation.
        OperationMode oldMode,   // The old mode of the accommodation.
        OperationMode newMode    // The new mode of the accommodation.
    );

    // -------------------- Errors -----------------------------------

    /// @dev The zero amount of tokens has been passed when request a relocation.
    error ZeroRelocationAmount();

    /// @dev Relocation to the provided chain is not supported by this bridge.
    error UnsupportedRelocation();

    /// @dev The underlying token contract does not support this bridge to execute needed operations.
    error UnsupportingToken();

    /// @dev The transaction sender is not authorized to execute the requested function with provided arguments.
    error UnauthorizedTransactionSender();

    /// @dev The provided array of relocation nonces as a function argument is empty.
    error EmptyNonceArray();

    /// @dev The zero relocation count has been passed as a function argument.
    error ZeroRelocationCount();

    /// @dev The requested count of relocations to process is greater than the current number of pending relocations.
    error LackOfPendingRelocations();

    /// @dev A token burning failure happened during a bridge operation.
    error TokenBurningFailure();

    /// @dev Accommodation from the provided chain for the underlying token contract is not supported by this bridge.
    error UnsupportedAccommodation();

    /// @dev The zero nonce has been passed to accommodate tokens.
    error ZeroAccommodationNonce();

    /// @dev A nonce mismatch has been found during token accommodation.
    error AccommodationNonceMismatch();

    /// @dev The provided array of relocations as a function argument is empty.
    error EmptyRelocationArray();

    /// @dev The zero account address has been passed to accommodate tokens.
    error ZeroAccommodationAccount();

    /// @dev The zero amount of tokens has been passed to accommodate tokens.
    error ZeroAccommodationAmount();

    /// @dev A token minting failure happened during a bridge operation.
    error TokenMintingFailure();

    /// @dev The underlying token contract does not support the bridge operations.
    error NonBridgeableToken();

    /// @dev The mode of the relocation to the provided chain has not been changed during the function call.
    error UnchangedRelocationMode();

    /// @dev The mode of the accommodation from the provided chain has not been changed during the function call.
    error UnchangedAccommodationMode();

    /// @dev The relocation with the provided nonce is already processed so it cannot be canceled.
    error AlreadyProcessedRelocation();

    /// @dev The relocation with the provided nonce does not exist so it cannot be canceled.
    error NotExistentRelocation();

    /// @dev The relocation with the provided nonce is already canceled.
    error AlreadyCanceledRelocation();

    // ------------------- Functions ---------------------------------

    function initialize(address token_) public initializer {
        __TokenBridge_init(token_);
    }

    function __TokenBridge_init(address token_) internal onlyInitializing {
        __AccessControl_init_unchained();
        __Context_init_unchained();
        __ERC165_init_unchained();
        __Pausable_init_unchained();
        __PauseControl_init_unchained(OWNER_ROLE);
        __RescueControl_init_unchained(OWNER_ROLE);

        __TokenBridge_init_unchained(token_);
    }

    function __TokenBridge_init_unchained(address token_) internal onlyInitializing {
        _token = token_;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(BRIDGER_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /// @dev See {ITokenBridge-underlyingToken}.
    function underlyingToken() external view returns (address) {
        return _token;
    }

    /// @dev See {ITokenBridge-getPendingRelocationCounter}.
    function getPendingRelocationCounter(uint256 chainId) external view returns (uint256) {
        return _pendingRelocationCounters[chainId];
    }

    /// @dev See {ITokenBridge-getLastProcessedRelocationNonce}.
    function getLastProcessedRelocationNonce(uint256 chainId) external view returns (uint256) {
        return _lastProcessedRelocationNonces[chainId];
    }

    /// @dev See {ITokenBridge-getRelocationMode}.
    function getRelocationMode(uint256 chainId) external view returns (OperationMode) {
        return _relocationModes[chainId];
    }

    /// @dev See {ITokenBridge-getRelocation}.
    function getRelocation(uint256 chainId, uint256 nonce) external view returns (Relocation memory) {
        return _relocations[chainId][nonce];
    }

    /// @dev See {ITokenBridge-getAccommodationMode}.
    function getAccommodationMode(uint256 chainId) external view returns (OperationMode) {
        return _accommodationModes[chainId];
    }

    /// @dev See {ITokenBridge-getLastAccommodationNonce}.
    function getLastAccommodationNonce(uint256 chainId) external view returns (uint256) {
        return _lastAccommodationNonces[chainId];
    }

    /// @dev See {ITokenBridge-getRelocations}.
    function getRelocations(
        uint256 chainId,
        uint256 nonce,
        uint256 count
    ) external view returns (Relocation[] memory relocations) {
        relocations = new Relocation[](count);
        for (uint256 i = 0; i < count; i++) {
            relocations[i] = _relocations[chainId][nonce];
            nonce += 1;
        }
    }

    /**
     * @dev See {ITokenBridge-requestRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The provided amount of tokens to relocate must not be zero.
     * - The relocation to the destination chain must be supported.
     * - If the mode of the relocation is BurnOrMint
     *   the underlying token contract must support this bridge to execute needed operation.
     * - The caller must have the provided amount of tokens.
     */
    function requestRelocation(uint256 chainId, uint256 amount) external whenNotPaused returns (uint256 nonce) {
        if (amount == 0) {
            revert ZeroRelocationAmount();
        }
        OperationMode mode = _relocationModes[chainId];
        if (mode == OperationMode.Unsupported) {
            revert UnsupportedRelocation();
        }
        if (mode == OperationMode.BurnOrMint) {
            if (!IERC20Bridgeable(_token).isBridgeSupported(address(this))) {
                revert UnsupportingToken();
            }
        }

        uint256 newPendingRelocationCount = _pendingRelocationCounters[chainId] + 1;
        nonce = _lastProcessedRelocationNonces[chainId] + newPendingRelocationCount;
        _pendingRelocationCounters[chainId] = newPendingRelocationCount;
        Relocation storage relocation = _relocations[chainId][nonce];
        relocation.account = _msgSender();
        relocation.amount = amount;

        IERC20Upgradeable(_token).safeTransferFrom(
            _msgSender(),
            address(this),
            amount
        );

        emit RequestRelocation(
            chainId,
            _msgSender(),
            amount,
            nonce
        );
    }

    /**
     * @dev See {ITokenBridge-cancelRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must be the initiator of the relocation that is being canceled.
     * - The relocation for the provided chain ID and nonce must not be already processed.
     * - The relocation for the provided chain ID and nonce must exist.
     * - The relocation for the provided chain ID and nonce must not be already canceled.
     */
    function cancelRelocation(uint256 chainId, uint256 nonce) external whenNotPaused {
        if (_relocations[chainId][nonce].account != _msgSender()) {
            revert UnauthorizedTransactionSender();
        }

        cancelRelocationInternal(chainId, nonce);
    }

    /**
     * @dev See {ITokenBridge-cancelRelocations}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The provided array of relocation nonces must not be empty.
     * - All the relocation for the provided chain ID and nonces must not be already processed.
     * - All the relocation for the provided chain ID and nonces must exist.
     * - All the relocation for the provided chain ID and nonces must not be already canceled.
     */
    function cancelRelocations(uint256 chainId, uint256[] memory nonces) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        if (nonces.length == 0) {
            revert EmptyNonceArray();
        }

        for (uint256 i = 0; i < nonces.length; i++) {
            cancelRelocationInternal(chainId, nonces[i]);
        }
    }

    /**
     * @dev See {ITokenBridge-relocate}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The provided count of relocations to process must not be zero.
     * - The provided count of relocations to process must not be greater than the number of pending relocations.
     * - For all the relocations that are executed is BurnOrMint operation mode
     *   the underlying token contract must support this bridge and must execute burning operations successfully.
     */
    function relocate(uint256 chainId, uint256 count) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        if (count == 0) {
            revert ZeroRelocationCount();
        }
        uint256 currentPendingRelocationCount = _pendingRelocationCounters[chainId];
        if (count > currentPendingRelocationCount) {
            revert LackOfPendingRelocations();
        }
        OperationMode mode = _relocationModes[chainId];
        if (mode == OperationMode.BurnOrMint) {
            if (!IERC20Bridgeable(_token).isBridgeSupported(address(this))) {
                revert UnsupportingToken();
            }
        }

        uint256 fromNonce = _lastProcessedRelocationNonces[chainId] + 1;
        uint256 toNonce = fromNonce + count - 1;

        _pendingRelocationCounters[chainId] = currentPendingRelocationCount - count;
        _lastProcessedRelocationNonces[chainId] = toNonce;

        for (uint256 nonce = fromNonce; nonce <= toNonce; nonce++) {
            Relocation memory relocation = _relocations[chainId][nonce];
            if (!relocation.canceled) {
                relocateInternal(relocation, mode);
                emit Relocate(
                    chainId,
                    relocation.account,
                    relocation.amount,
                    nonce,
                    mode
                );
            }
        }
    }

    /**
     * @dev See {ITokenBridge-accommodate}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The provided nonce of the first relocation must not be zero.
     * - The provided nonce of the first relocation must be one more than the nonce of the last accommodation.
     * - The provided array of relocations must not be empty.
     * - This bridge must support accommodations from the chain with the provided ID.
     * - All the provided relocations must have non-zero account address.
     * - All the provided relocations must have non-zero token amount.
     * - If operation mode of accommodations from the chain with the provided ID is BurnAndMint
     *   the underlying token contract must support this bridge and must execute minting operations successfully.
     */
    function accommodate(
        uint256 chainId,
        uint256 nonce,
        Relocation[] memory relocations
    ) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        if (_accommodationModes[chainId] == OperationMode.Unsupported) {
            revert UnsupportedAccommodation();
        }
        if (nonce == 0) {
            revert ZeroAccommodationNonce();
        }
        if (_lastAccommodationNonces[chainId] != (nonce - 1)) {
            revert AccommodationNonceMismatch();
        }
        if (relocations.length == 0) {
            revert EmptyRelocationArray();
        }
        OperationMode mode = _accommodationModes[chainId];
        if (mode == OperationMode.BurnOrMint) {
            if (!IERC20Bridgeable(_token).isBridgeSupported(address(this))) {
                revert UnsupportingToken();
            }
        }

        for (uint256 i = 0; i < relocations.length; i++) {
            Relocation memory relocation = relocations[i];
            if (relocation.account == address(0)) {
                revert ZeroAccommodationAccount();
            }
            if (relocation.amount == 0) {
                revert ZeroAccommodationAmount();
            }
            if (!relocation.canceled) {
                accommodateInternal(relocation, mode);
                emit Accommodate(
                    chainId,
                    relocation.account,
                    relocation.amount,
                    nonce,
                    mode
                );
            }
            nonce += 1;
        }

        _lastAccommodationNonces[chainId] = nonce - 1;
    }

    /**
     * @dev Sets the mode of relocation to a destination chain.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new relocation mode must defer from the current one.
     * - If the new relocation mode is BurnOrMint the underlying token contract must support the bridge operations.
     *
     * Emits a {SetRelocationMode} event.
     *
     * @param chainId The ID of the destination chain to relocate to.
     * @param newMode The new relocation mode.
     */
    function setRelocationMode(uint256 chainId, OperationMode newMode) external onlyRole(OWNER_ROLE) {
        OperationMode oldMode = _relocationModes[chainId];
        if (oldMode == newMode) {
            return;
        }
        if (newMode == OperationMode.BurnOrMint) {
            if (!isTokenIERC20BridgeableInternal(_token)) {
                revert NonBridgeableToken();
            }
        }
        _relocationModes[chainId] = newMode;
        emit SetRelocationMode(chainId, oldMode, newMode);
    }

    /**
     * @dev Sets the mode of accommodation from a source chain.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new accommodation mode must defer from the current one.
     * - If the new accommodation mode is BurnOrMint the underlying token contract must support the bridge operations.
     *
     * Emits a {SetAccommodationMode} event.
     *
     * @param chainId The ID of the source chain to accommodate from.
     * @param newMode The new accommodation mode.
     */
    function setAccommodationMode(uint256 chainId, OperationMode newMode) external onlyRole(OWNER_ROLE) {
        OperationMode oldMode = _accommodationModes[chainId];
        if (oldMode == newMode) {
            return;
        }
        if (newMode == OperationMode.BurnOrMint) {
            if (!isTokenIERC20BridgeableInternal(_token)) {
                revert NonBridgeableToken();
            }
        }
        _accommodationModes[chainId] = newMode;
        emit SetAccommodationMode(chainId, oldMode, newMode);
    }

    function cancelRelocationInternal(uint256 chainId, uint256 nonce) internal {
        uint256 lastProcessedRelocationNonce = _lastProcessedRelocationNonces[chainId];
        if (nonce <= lastProcessedRelocationNonce) {
            revert AlreadyProcessedRelocation();
        }
        if (nonce > lastProcessedRelocationNonce + _pendingRelocationCounters[chainId]) {
            revert NotExistentRelocation();
        }

        Relocation storage relocation = _relocations[chainId][nonce];

        if (relocation.canceled) {
            revert AlreadyCanceledRelocation();
        }

        relocation.canceled = true;
        IERC20Upgradeable(_token).safeTransfer(relocation.account, relocation.amount);

        emit CancelRelocation(
            chainId,
            relocation.account,
            relocation.amount,
            nonce
        );
    }

    function relocateInternal(Relocation memory relocation, OperationMode mode) internal {
        if (mode == OperationMode.BurnOrMint) {
            bool burningSuccess = IERC20Bridgeable(_token).burnForBridging(
                relocation.account,
                relocation.amount
            );
            if (!burningSuccess) {
                revert TokenBurningFailure();
            }
        } else {
            // Do nothing, tokens are locked on the bridge account
        }
    }

    function accommodateInternal(Relocation memory relocation, OperationMode mode) internal {
        if (mode == OperationMode.BurnOrMint) {
            bool mintingSuccess = IERC20Bridgeable(_token).mintForBridging(
                relocation.account,
                relocation.amount
            );
            if (!mintingSuccess) {
                revert TokenMintingFailure();
            }
        } else {
            IERC20Upgradeable(_token).safeTransfer(relocation.account, relocation.amount);
        }
    }

    // Safely call the appropriate function from the IERC20Bridgeable interface.
    function isTokenIERC20BridgeableInternal(address token_) internal virtual returns (bool) {
        (bool success, bytes memory result) = token_.staticcall(abi.encodeWithSignature("isIERC20Bridgeable()"));
        if (success && result.length > 0) {
            return abi.decode(result, (bool));
        } else {
            return false;
        }
    }
}
