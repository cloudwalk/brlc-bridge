// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IERC20Bridgeable } from "./interfaces/IERC20Bridgeable.sol";
import { IMultiTokenBridge } from "./interfaces/IMultiTokenBridge.sol";
import { MultiTokenBridgeStorage } from "./MultiTokenBridgeStorage.sol";
import { PauseControlUpgradeable } from "./base/PauseControlUpgradeable.sol";
import { RescueControlUpgradeable } from "./base/RescueControlUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder.sol";

/**
 * @title MultiTokenBridgeUpgradeable contract
 * @dev Allows to bridge coins of multiple token contracts between blockchains.
 * See terms in the comments of the {IMultiTokenBridge} interface.
 */
contract MultiTokenBridge is
    AccessControlUpgradeable,
    PauseControlUpgradeable,
    RescueControlUpgradeable,
    StoragePlaceholder200,
    MultiTokenBridgeStorage,
    IMultiTokenBridge
{
    /// @dev The contract owner role.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role who is allowed to execute bridge operations.
    bytes32 public constant BRIDGER_ROLE = keccak256("BRIDGER_ROLE");

    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -------------------- Events -----------------------------------

    /// @dev Emitted when the mode of relocation with specified parameters is changed.
    event SetRelocationMode(
        uint256 indexed chainId, // The destination chain ID of the relocation.
        address indexed token,   // The address of the token contract whose coins are being relocated.
        OperationMode oldMode,   // The old mode of the relocation.
        OperationMode newMode    // The new mode of the relocation.
    );

    /// @dev Emitted when mode of accommodation with specified parameters is changed.
    event SetAccommodationMode(
        uint256 indexed chainId, // The source chain ID of the accommodation.
        address indexed token,   // The address of the token contract whose coins are being accommodated.
        OperationMode oldMode,   // The old mode of the accommodation.
        OperationMode newMode    // The new mode of the accommodation.
    );

    // -------------------- Errors -----------------------------------

    /// @dev The zero address of a token contract has been passed when request a relocation.
    error ZeroRelocationTokenAddress();

    /// @dev The zero amount of tokens has been passed when request a relocation.
    error ZeroRelocationAmount();

    /// @dev Relocation to the provided chain for the provided token is not supported by this bridge.
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

    /// @dev The zero nonce has been passed to accommodate tokens.
    error ZeroAccommodationNonce();

    /// @dev A nonce mismatch has been found during token accommodation.
    error AccommodationNonceMismatch();

    /// @dev The provided array of relocations as a function argument is empty.
    error EmptyRelocationArray();

    /// @dev Accommodation from the provided chain for the provided token contract is not supported by this bridge.
    error UnsupportedAccommodation();

    /// @dev The zero account address has been passed to accommodate tokens.
    error ZeroAccommodationAccount();

    /// @dev The zero amount of tokens has been passed to accommodate tokens.
    error ZeroAccommodationAmount();

    /// @dev A token minting failure happened during a bridge operation.
    error TokenMintingFailure();

    /// @dev The provided token contract does not support the bridge operations.
    error NonBridgeableToken();

    /// @dev The relocation with the provided nonce is already processed so it cannot be canceled.
    error AlreadyProcessedRelocation();

    /// @dev The relocation with the provided nonce does not exist so it cannot be canceled.
    error NotExistentRelocation();

    /// @dev The relocation with the provided nonce is already canceled.
    error AlreadyCanceledRelocation();

    /// @dev The mode of relocation has not been changed.
    error UnchangedRelocationMode();

    /// @dev The mode of accommodation has not been changed.
    error UnchangedAccommodationMode();

    // -------------------- Functions -----------------------------------

    function initialize() public initializer {
        __MultiTokenBridge_init();
    }

    function __MultiTokenBridge_init() internal onlyInitializing {
        __AccessControl_init_unchained();
        __Context_init_unchained();
        __ERC165_init_unchained();
        __Pausable_init_unchained();
        __PauseControl_init_unchained(OWNER_ROLE);
        __RescueControl_init_unchained(OWNER_ROLE);

        __MultiTokenBridge_init_unchained();
    }

    function __MultiTokenBridge_init_unchained() internal onlyInitializing {
        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(BRIDGER_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /// @dev See {IMultiTokenBridge-getPendingRelocationCounter}.
    function getPendingRelocationCounter(uint256 chainId) external view returns (uint256) {
        return _pendingRelocationCounters[chainId];
    }

    /// @dev See {IMultiTokenBridge-getLastProcessedRelocationNonce}.
    function getLastProcessedRelocationNonce(uint256 chainId) external view returns (uint256) {
        return _lastProcessedRelocationNonces[chainId];
    }

    /// @dev See {IMultiTokenBridge-getRelocationMode}.
    function getRelocationMode(uint256 chainId, address token) external view returns (OperationMode) {
        return _relocationModes[chainId][token];
    }

    /// @dev See {IMultiTokenBridge-getRelocation}.
    function getRelocation(uint256 chainId, uint256 nonce) external view returns (Relocation memory) {
        return _relocations[chainId][nonce];
    }

    /// @dev See {IMultiTokenBridge-getAccommodationMode}.
    function getAccommodationMode(uint256 chainId, address token) external view returns (OperationMode) {
        return _accommodationModes[chainId][token];
    }

    /// @dev See {IMultiTokenBridge-getLastAccommodationNonce}.
    function getLastAccommodationNonce(uint256 chainId) external view returns (uint256) {
        return _lastAccommodationNonces[chainId];
    }

    /// @dev See {IMultiTokenBridge-getRelocations}.
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
     * @dev See {IMultiTokenBridge-requestRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The provided address of the token contract whose coins are being relocated must not be zero.
     * - The provided amount of tokens to relocate must not be zero.
     * - The relocation to the destination chain for the provided token contract must be supported.
     * - If the mode of the relocation is BurnOrMint
     *   the provided token contract must support this bridge to execute needed operation.
     * - The caller must have the provided amount of tokens.
     */
    function requestRelocation(
        uint256 chainId,
        address token,
        uint256 amount
    ) external whenNotPaused returns (uint256 nonce) {
        if (token == address(0)) {
            revert ZeroRelocationTokenAddress();
        }
        if (amount == 0) {
            revert ZeroRelocationAmount();
        }
        OperationMode mode = _relocationModes[chainId][token];
        if (mode == OperationMode.Unsupported) {
            revert UnsupportedRelocation();
        }
        if (mode == OperationMode.BurnOrMint) {
            if (!IERC20Bridgeable(token).isBridgeSupported(address(this))) {
                revert UnsupportingToken();
            }
        }

        uint256 newPendingRelocationCount = _pendingRelocationCounters[chainId] + 1;
        nonce = _lastProcessedRelocationNonces[chainId] + newPendingRelocationCount;
        _pendingRelocationCounters[chainId] = newPendingRelocationCount;
        Relocation storage relocation = _relocations[chainId][nonce];
        relocation.account = _msgSender();
        relocation.token = token;
        relocation.amount = amount;

        IERC20Upgradeable(token).safeTransferFrom(
            _msgSender(),
            address(this),
            amount
        );

        emit RequestRelocation(
            chainId,
            token,
            _msgSender(),
            amount,
            nonce
        );
    }

    /**
     * @dev See {IMultiTokenBridge-cancelRelocation}.
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
     * @dev See {IMultiTokenBridge-cancelRelocations}.
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
     * @dev See {IMultiTokenBridge-relocate}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The provided count of relocations to process must not be zero.
     * - The provided count of relocations to process must not be greater than the number of pending relocations.
     * - For all the relocations that are executed is BurnOrMint operation mode
     *   the related token contracts whose coins are being relocated must support this bridge
     *   and must execute burning operations successfully.
     */
    function relocate(uint256 chainId, uint256 count) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        if (count == 0) {
            revert ZeroRelocationCount();
        }
        uint256 currentPendingRelocationCount = _pendingRelocationCounters[chainId];
        if (count > currentPendingRelocationCount) {
            revert LackOfPendingRelocations();
        }

        uint256 fromNonce = _lastProcessedRelocationNonces[chainId] + 1;
        uint256 toNonce = fromNonce + count - 1;

        _pendingRelocationCounters[chainId] = currentPendingRelocationCount - count;
        _lastProcessedRelocationNonces[chainId] = toNonce;

        for (uint256 nonce = fromNonce; nonce <= toNonce; nonce++) {
            Relocation memory relocation = _relocations[chainId][nonce];
            if (!relocation.canceled) {
                OperationMode mode = _relocationModes[chainId][relocation.token];
                relocateInternal(relocation, mode);
                emit Relocate(
                    chainId,
                    relocation.token,
                    relocation.account,
                    relocation.amount,
                    nonce,
                    mode
                );
            }
        }
    }

    /**
     * @dev See {IMultiTokenBridge-accommodate}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The provided nonce of the first relocation must not be zero.
     * - The provided nonce of the first relocation must be one more than the nonce of the last accommodation.
     * - The provided array of relocations must not be empty.
     * - This bridge must support accommodations from the chain with the provided ID and
     *   for all token contracts of the provided array of relocations.
     * - All the provided relocations must have non-zero account address.
     * - All the provided relocations must have non-zero token amount.
     * - For all the accommodations whose mode is BurnAndMint
     *   the related token contracts whose coins are being accommodated must support this bridge
     *   and must execute minting operations successfully.
     */
    function accommodate(
        uint256 chainId,
        uint256 nonce,
        Relocation[] memory relocations
    ) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        if (nonce == 0) {
            revert ZeroAccommodationNonce();
        }
        if (_lastAccommodationNonces[chainId] != (nonce - 1)) {
            revert AccommodationNonceMismatch();
        }
        if (relocations.length == 0) {
            revert EmptyRelocationArray();
        }

        for (uint256 i = 0; i < relocations.length; i++) {
            Relocation memory relocation = relocations[i];
            if (_accommodationModes[chainId][relocation.token] == OperationMode.Unsupported) {
                revert UnsupportedAccommodation();
            }
            if (relocation.account == address(0)) {
                revert ZeroAccommodationAccount();
            }
            if (relocation.amount == 0) {
                revert ZeroAccommodationAmount();
            }
            if (!relocation.canceled) {
                OperationMode mode = _accommodationModes[chainId][relocation.token];
                accommodateInternal(relocation, mode);
                emit Accommodate(
                    chainId,
                    relocation.token,
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
     * @dev Sets the mode of relocation to a destination chain for a local token contract.
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
     * @param token The address of the local token contract whose coins are being relocated.
     * @param newMode The new relocation mode.
     */
    function setRelocationMode(
        uint256 chainId,
        address token,
        OperationMode newMode
    ) external onlyRole(OWNER_ROLE) {
        OperationMode oldMode = _relocationModes[chainId][token];
        if (oldMode == newMode) {
            revert UnchangedRelocationMode();
        }
        if (newMode == OperationMode.BurnOrMint) {
            if (!isTokenIERC20BridgeableInternal(token)) {
                revert NonBridgeableToken();
            }
        }
        _relocationModes[chainId][token] = newMode;
        emit SetRelocationMode(chainId, token, oldMode, newMode);
    }

    /**
     * @dev Sets the mode of accommodation from a source chain for a local token contract.
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
     * @param token The address of the local token contract whose coins are being accommodated.
     * @param newMode The new accommodation mode.
     */
    function setAccommodationMode(
        uint256 chainId,
        address token,
        OperationMode newMode
    ) external onlyRole(OWNER_ROLE) {
        OperationMode oldMode = _accommodationModes[chainId][token];
        if (oldMode == newMode) {
            revert UnchangedAccommodationMode();
        }
        if (newMode == OperationMode.BurnOrMint) {
            if (!isTokenIERC20BridgeableInternal(token)) {
                revert NonBridgeableToken();
            }
        }
        _accommodationModes[chainId][token] = newMode;
        emit SetAccommodationMode(chainId, token, oldMode, newMode);
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
        IERC20Upgradeable(relocation.token).safeTransfer(relocation.account, relocation.amount);

        emit CancelRelocation(
            chainId,
            relocation.token,
            relocation.account,
            relocation.amount,
            nonce
        );
    }

    function relocateInternal(Relocation memory relocation, OperationMode mode) internal {
        if (mode == OperationMode.BurnOrMint) {
            if (!IERC20Bridgeable(relocation.token).isBridgeSupported(address(this))) {
                revert UnsupportingToken();
            }
            bool burningSuccess = IERC20Bridgeable(relocation.token).burnForBridging(
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
            if (!IERC20Bridgeable(relocation.token).isBridgeSupported(address(this))) {
                revert UnsupportingToken();
            }
            bool mintingSuccess = IERC20Bridgeable(relocation.token).mintForBridging(
                relocation.account,
                relocation.amount
            );
            if (!mintingSuccess) {
                revert TokenMintingFailure();
            }
        } else {
            IERC20Upgradeable(relocation.token).safeTransfer(relocation.account, relocation.amount);
        }
    }

    // Safely call the appropriate function from the IERC20Bridgeable interface.
    function isTokenIERC20BridgeableInternal(address token) internal virtual returns (bool) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeWithSignature("isIERC20Bridgeable()"));
        if (success && result.length > 0) {
            return abi.decode(result, (bool));
        } else {
            return false;
        }
    }
}
