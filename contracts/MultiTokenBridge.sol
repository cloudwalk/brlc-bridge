// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { PausableExtUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "@cloudwalkinc/brlc-contracts/contracts/storage/StoragePlaceholder200.sol";

import { MultiTokenBridgeStorage } from "./MultiTokenBridgeStorage.sol";
import { IMultiTokenBridge } from "./interfaces/IMultiTokenBridge.sol";
import { IERC20Bridgeable } from "./interfaces/IERC20Bridgeable.sol";
import { IBridgeFeeOracle } from "./interfaces/IBridgeFeeOracle.sol";

/**
 * @title MultiTokenBridgeUpgradeable contract
 * @author CloudWalk Inc.
 * @dev The bridge contract that supports bridging of multiple tokens.
 * See terms in the comments of the {IMultiTokenBridge} interface.
 */
contract MultiTokenBridge is
    AccessControlUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    StoragePlaceholder200,
    MultiTokenBridgeStorage,
    IMultiTokenBridge
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of bridger that is allowed to execute bridging operations.
    bytes32 public constant BRIDGER_ROLE = keccak256("BRIDGER_ROLE");

    // -------------------- Events -----------------------------------

    /// @dev Emitted when the mode of relocation is changed.
    event SetRelocationMode(
        uint256 indexed chainId, // The destination chain ID of the relocation.
        address indexed token,   // The address of the token used for relocation.
        OperationMode oldMode,   // The old mode of relocation.
        OperationMode newMode    // The new mode of relocation.
    );

    /// @dev Emitted when the mode of accommodation is changed.
    event SetAccommodationMode(
        uint256 indexed chainId, // The source chain ID of the accommodation.
        address indexed token,   // The address of the token used for accommodation.
        OperationMode oldMode,   // The old mode of accommodation.
        OperationMode newMode    // The new mode of accommodation.
    );

    /// @dev Emitted when the fee oracle is changed.
    event SetFeeOracle(
        address oldOracle, // The address of the old fee oracle.
        address newOracle  // The address of the new fee oracle.
    );

    /// @dev Emitted when the fee collector address is changed.
    event SetFeeCollector(
        address oldCollector, // The address of the old fee collector.
        address newCollector  // The address of the new fee collector.
    );

    // -------------------- Errors -----------------------------------

    /// @dev The zero token address has been passed when requesting a relocation.
    error ZeroRelocationToken();

    /// @dev The zero amount of tokens has been passed when requesting a relocation.
    error ZeroRelocationAmount();

    /// @dev The zero count of relocations has been passed when processing pending relocations.
    error ZeroRelocationCount();

    /// @dev The count of relocations to process is greater than the number of pending relocations.
    error LackOfPendingRelocations();

    /// @dev The relocation to the destination chain for the provided token is not supported.
    error UnsupportedRelocation();

    /**
     * @dev The relocation with the provided nonce has an inappropriate status.
     * @param currentStatus The current status of the relocation.
     */
    error InappropriateRelocationStatus(RelocationStatus currentStatus);

    /// @dev The zero nonce has been passed when processing accommodation operations.
    error ZeroAccommodationNonce();

    /// @dev A nonce mismatch has been found when processing accommodation operations.
    error AccommodationNonceMismatch();

    /// @dev An empty array of relocations has been passed when processing accommodation operations.
    error EmptyAccommodationRelocationsArray();

    /// @dev An accommodation from the source chain for the provided token contract is not supported.
    error UnsupportedAccommodation();

    /// @dev The zero account has been found when processing an accommodation operations.
    error ZeroAccommodationAccount();

    /// @dev The zero amount has been found when processing an accommodation operations.
    error ZeroAccommodationAmount();

    /// @dev The minting of tokens failed when processing an accommodation operation.
    error TokenMintingFailure();

    /// @dev The burning of tokens failed when processing a relocation operation.
    error TokenBurningFailure();

    /// @dev The token contract does not support the {IERC20Bridgeable} interface.
    error NonBridgeableToken();

    /// @dev The mode of relocation is immutable and it has been already set.
    error RelocationModeIsImmutable();

    /// @dev The mode of accommodation is immutable and it has been already set.
    error AccommodationModeIsImmutable();

    /// @dev The mode of relocation has not been changed.
    error UnchangedRelocationMode();

    /// @dev The mode of accommodation has not been changed.
    error UnchangedAccommodationMode();

    /// @dev The fee oracle has not been changed.
    error UnchangedFeeOracle();

    /// @dev The fee collector has not been changed.
    error UnchangedFeeCollector();

    // -------------------- Functions -----------------------------------

    /**
     * @dev Constructor that prohibits the initialization of the implementation of the upgradable contract.
     *
     * See details
     * https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#initializing_the_implementation_contract
     *
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev The initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable .
     */
    function initialize() public initializer {
        __MultiTokenBridge_init();
    }

    /**
     * @dev The internal initializer of the upgradable contract.
     *
     * See {MultiTokenBridge-initialize}.
     */
    function __MultiTokenBridge_init() internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();
        __Pausable_init_unchained();
        __PausableExt_init_unchained(OWNER_ROLE);
        __Rescuable_init_unchained(OWNER_ROLE);

        __MultiTokenBridge_init_unchained();
    }

    /**
     * @dev The unchained internal initializer of the upgradable contract.
     *
     * See {MultiTokenBridge-initialize}.
     */
    function __MultiTokenBridge_init_unchained() internal onlyInitializing {
        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(BRIDGER_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /**
     * @dev See {IMultiTokenBridge-requestRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The token address used for relocation must not be zero.
     * - The amount of tokens to relocate must be greater than zero.
     * - The relocation to the destination chain for the provided token must be supported.
     */
    function requestRelocation(
        uint256 chainId,
        address token,
        uint256 amount
    ) external whenNotPaused returns (uint256 nonce) {
        if (token == address(0)) {
            revert ZeroRelocationToken();
        }
        if (amount == 0) {
            revert ZeroRelocationAmount();
        }

        OperationMode mode = _relocationModes[chainId][token];

        if (mode == OperationMode.Unsupported) {
            revert UnsupportedRelocation();
        }

        address sender = _msgSender();

        uint256 newPendingRelocationCount = _pendingRelocationCounters[chainId] + 1;
        nonce = _lastProcessedRelocationNonces[chainId] + newPendingRelocationCount;
        _pendingRelocationCounters[chainId] = newPendingRelocationCount;
        Relocation storage relocation = _relocations[chainId][nonce];
        relocation.account = sender;
        relocation.token = token;
        relocation.amount = amount;
        relocation.status = RelocationStatus.Pending;

        uint256 fee = _defineFee(chainId, token, sender, amount);

        if (fee != 0) {
            relocation.fee = fee;
        }

        emit RequestRelocation(
            chainId,
            token,
            sender,
            amount,
            nonce,
            fee
        );

        IERC20Upgradeable(token).safeTransferFrom(
            sender,
            address(this),
            amount + fee
        );
    }

    /**
     * @dev See {IMultiTokenBridge-cancelRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The caller must be the initiator of the relocation that is being canceled.
     * - The relocation for the provided chain ID and nonce must have the pending or postponed status.
     */
    function cancelRelocation(
        uint256 chainId,
        uint256 nonce,
        FeeRefundMode feeRefundMode
    ) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        _refuseRelocation(chainId, nonce, RelocationStatus.Canceled, feeRefundMode);
    }

    /**
     * @dev See {IMultiTokenBridge-relocate}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The provided count of relocations to process must not be zero
     *   and must be less than or equal to the number of pending relocations.
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
            _relocate(chainId, nonce);
        }
    }

    /**
     * @dev See {IMultiTokenBridge-rejectRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The relocation for the provided chain ID and nonce must have the pending or postponed status.
     */
    function rejectRelocation(
        uint256 chainId,
        uint256 nonce,
        FeeRefundMode feeRefundMode
    ) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        _refuseRelocation(chainId, nonce, RelocationStatus.Rejected, feeRefundMode);
    }

    /**
     * @dev See {IMultiTokenBridge-abortRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The relocation for the provided chain ID and nonce must have the pending or postponed status.
     */
    function abortRelocation(uint256 chainId, uint256 nonce) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        _refuseRelocation(chainId, nonce, RelocationStatus.Aborted, FeeRefundMode.Nothing);
    }

    /**
     * @dev See {IMultiTokenBridge-postponeRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The relocation for the provided chain ID and nonce must have the pending status.
     */
    function postponeRelocation(uint256 chainId, uint256 nonce) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        Relocation storage storedRelocation = _relocations[chainId][nonce];
        Relocation memory relocation = storedRelocation;

        if (relocation.status != RelocationStatus.Pending) {
            revert InappropriateRelocationStatus(relocation.status);
        }

        storedRelocation.status = RelocationStatus.Postponed;

        emit PostponeRelocation(
            chainId,
            relocation.token,
            relocation.account,
            relocation.amount,
            nonce
        );
    }

    /**
     * @dev See {IMultiTokenBridge-continueRelocation}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The relocation for the provided chain ID and nonce must have the postponed status.
     */
    function continueRelocation(uint256 chainId, uint256 nonce) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        Relocation storage oldStoredRelocation = _relocations[chainId][nonce];
        Relocation memory oldRelocation = oldStoredRelocation;

        if (oldRelocation.status != RelocationStatus.Postponed) {
            revert InappropriateRelocationStatus(oldRelocation.status);
        }

        uint256 newPendingRelocationCount = _pendingRelocationCounters[chainId] + 1;
        uint256 newNonce = _lastProcessedRelocationNonces[chainId] + newPendingRelocationCount;
        _pendingRelocationCounters[chainId] = newPendingRelocationCount;

        Relocation storage newStoredRelocation = _relocations[chainId][newNonce];
        newStoredRelocation.account = oldRelocation.account;
        newStoredRelocation.token = oldRelocation.token;
        newStoredRelocation.amount = oldRelocation.amount;
        newStoredRelocation.status = RelocationStatus.Pending;
        newStoredRelocation.oldNonce = nonce;

        oldStoredRelocation.status = RelocationStatus.Continued;
        oldStoredRelocation.newNonce = newNonce;

        emit ContinueRelocation(
            chainId,
            oldRelocation.token,
            oldRelocation.account,
            oldRelocation.amount,
            nonce,
            newNonce
        );
    }

    /**
     * @dev See {IMultiTokenBridge-accommodate}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {BRIDGER_ROLE} role.
     * - The nonce of the first relocation must not be zero
     *   and must be greater than the nonce of the last accommodation.
     * - The array of relocations must not be empty and accommodation for
     *   each relocation in the array must be supported.
     * - All the provided relocations must have non-zero account address.
     * - All the provided relocations must have non-zero token amount.
     */
    function accommodate(
        uint256 chainId,
        uint256 nonce,
        Accommodation[] calldata accommodations
    ) external whenNotPaused onlyRole(BRIDGER_ROLE) {
        if (nonce == 0) {
            revert ZeroAccommodationNonce();
        }
        if (_lastAccommodationNonces[chainId] != (nonce - 1)) {
            revert AccommodationNonceMismatch();
        }
        if (accommodations.length == 0) {
            revert EmptyAccommodationRelocationsArray();
        }

        uint256 len = accommodations.length;
        for (uint256 i = 0; i < len; i++) {
            Accommodation calldata accommodation = accommodations[i];
            if (_accommodationModes[chainId][accommodation.token] == OperationMode.Unsupported) {
                revert UnsupportedAccommodation();
            }
            if (accommodation.account == address(0)) {
                revert ZeroAccommodationAccount();
            }
            if (accommodation.amount == 0) {
                revert ZeroAccommodationAmount();
            }

            if (accommodation.status == RelocationStatus.Processed) {
                OperationMode mode = _accommodationModes[chainId][accommodation.token];
                if (mode == OperationMode.BurnOrMint) {
                    bool mintingSuccess = IERC20Bridgeable(accommodation.token).mintForBridging(
                        accommodation.account,
                        accommodation.amount
                    );
                    if (!mintingSuccess) {
                        revert TokenMintingFailure();
                    }
                } else {
                    IERC20Upgradeable(accommodation.token).safeTransfer(accommodation.account, accommodation.amount);
                }
                emit Accommodate(
                    chainId,
                    accommodation.token,
                    accommodation.account,
                    accommodation.amount,
                    nonce,
                    mode
                );
            }

            nonce += 1;
        }

        _lastAccommodationNonces[chainId] = nonce - 1;
    }

    /**
     * @dev Sets the mode of relocation for a given destination chain and provided token.
     *
     * The new mode can be set only once due to of the relocation revoking logic.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The current mode of the relocation must be `Unsupported`.
     * - The new mode of relocation must be different from `Unsupported`.
     * - In the case of `BurnOrMint` relocation mode the token contract must
     *   support {IERC20Bridgeable} interface.
     *
     * Emits a {SetRelocationMode} event.
     *
     * @param chainId The ID of the destination chain to relocate tokens to.
     * @param token The address of the token used for relocation.
     * @param newMode The new mode of relocation.
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
        if (oldMode != OperationMode.Unsupported) {
            revert RelocationModeIsImmutable();
        }
        if (newMode == OperationMode.BurnOrMint) {
            if (!_isTokenIERC20Bridgeable(token)) {
                revert NonBridgeableToken();
            }
        }

        _relocationModes[chainId][token] = newMode;

        emit SetRelocationMode(chainId, token, oldMode, newMode);
    }

    /**
     * @dev Sets the mode of accommodation for a given source chain and provided token.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new mode of accommodation must be different from the current one.
     * - In the case of `BurnOrMint` accommodation mode the token contract must
     *   support {IERC20Bridgeable} interface.
     *
     * Emits a {SetAccommodationMode} event.
     *
     * @param chainId The ID of the source chain to accommodate tokens from.
     * @param token The address of the token used for accommodation.
     * @param newMode The new mode of accommodation.
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
        if (oldMode != OperationMode.Unsupported) {
            revert AccommodationModeIsImmutable();
        }
        if (newMode == OperationMode.BurnOrMint) {
            if (!_isTokenIERC20Bridgeable(token)) {
                revert NonBridgeableToken();
            }
        }

        _accommodationModes[chainId][token] = newMode;

        emit SetAccommodationMode(chainId, token, oldMode, newMode);
    }

    /**
     * @dev Sets the bridge fee oracle contract address.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new address of the oracle must be different from the current one.
     *
     * Emits a {SetFeeOracle} event.
     *
     * @param newOracle The address of the new oracle to set.
     */
    function setFeeOracle(address newOracle) external onlyRole(OWNER_ROLE) {
        address oldOracle = _feeOracle;
        if (oldOracle == newOracle) {
            revert UnchangedFeeOracle();
        }

        _feeOracle = newOracle;

        emit SetFeeOracle(oldOracle, newOracle);
    }

    /**
     * @dev Sets the address to collect bridge fees.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new address of the fee collector must be different from the current one.
     *
     * Emits a {SetFeeCollector} event.
     *
     * @param newCollector The address of the new fee collector to set.
     */
    function setFeeCollector(address newCollector) external onlyRole(OWNER_ROLE) {
        address oldCollector = _feeCollector;
        if (oldCollector == newCollector) {
            revert UnchangedFeeCollector();
        }

        _feeCollector = newCollector;

        emit SetFeeOracle(oldCollector, newCollector);
    }

    /**
     * @dev See {IMultiTokenBridge-getPendingRelocationCounter}.
     */
    function getPendingRelocationCounter(uint256 chainId) external view returns (uint256) {
        return _pendingRelocationCounters[chainId];
    }

    /**
     * @dev See {IMultiTokenBridge-getLastProcessedRelocationNonce}.
     */
    function getLastProcessedRelocationNonce(uint256 chainId) external view returns (uint256) {
        return _lastProcessedRelocationNonces[chainId];
    }

    /**
     * @dev See {IMultiTokenBridge-getRelocationMode}.
     */
    function getRelocationMode(uint256 chainId, address token) external view returns (OperationMode) {
        return _relocationModes[chainId][token];
    }

    /**
     * @dev See {IMultiTokenBridge-getRelocation}.
     */
    function getRelocation(uint256 chainId, uint256 nonce) external view returns (Relocation memory) {
        return _relocations[chainId][nonce];
    }

    /**
     * @dev See {IMultiTokenBridge-getAccommodationMode}.
     */
    function getAccommodationMode(uint256 chainId, address token) external view returns (OperationMode) {
        return _accommodationModes[chainId][token];
    }

    /**
     * @dev See {IMultiTokenBridge-getLastAccommodationNonce}.
     */
    function getLastAccommodationNonce(uint256 chainId) external view returns (uint256) {
        return _lastAccommodationNonces[chainId];
    }

    /**
     * @dev See {IMultiTokenBridge-getRelocations}.
     */
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
     * @dev See {IMultiTokenBridge-feeOracle}.
     */
    function feeOracle() external view returns (address) {
        return _feeOracle;
    }

    /**
     * @dev See {IMultiTokenBridge-feeCollector}.
     */
    function feeCollector() external view returns (address) {
        return _feeCollector;
    }

    /**
     * @dev See {IMultiTokenBridge-isFeeTaken}.
     */
    function isFeeTaken() external view returns (bool) {
        return (_feeOracle == address(0) || _feeCollector == address(0));
    }

    /**
     * @dev Defines the fee for a relocation.
     * @param chainId The destination chain ID of the relocation.
     * @param token The address of the token used for relocation.
     * @param account The account that requested the relocation.
     * @param amount The amount of tokens to relocate.
     */
    function _defineFee(
        uint256 chainId,
        address token,
        address account,
        uint256 amount
    ) internal view returns (uint256 fee) {
        fee = 0;
        address feeOracle_ = _feeOracle;
        if (feeOracle_ != address(0) && _feeCollector != address(0)) {
            fee = IBridgeFeeOracle(feeOracle_).defineFee(chainId, token, account, amount);
        }
    }

    /**
     * @dev Refuses a pending or postponed relocation with setting a new status.
     *
     * if the relocation is not aborted transfers tokens back from the bridge to the account.
     *
     * Requirements:
     *
     * - The relocation for the provided chain ID must have the pending status.
     *
     * Emits one of the following events depending on the target status:
     * {CancelRelocation}, {RejectRelocation}, {AbortRelocation}.
     *
     * @param chainId The destination chain ID of the relocation to cancel.
     * @param nonce The nonce of the pending relocation to cancel.
     */
    function _refuseRelocation(
        uint256 chainId,
        uint256 nonce,
        RelocationStatus targetStatus,
        FeeRefundMode feeRefundMode
    ) internal {
        Relocation storage storedRelocation = _relocations[chainId][nonce];
        Relocation memory relocation = storedRelocation;

        if (relocation.status != RelocationStatus.Pending && relocation.status != RelocationStatus.Postponed) {
            revert InappropriateRelocationStatus(relocation.status);
        }

        storedRelocation.status = targetStatus;

        if (targetStatus != RelocationStatus.Aborted) {
            if (targetStatus == RelocationStatus.Canceled) {
                emit CancelRelocation(
                    chainId,
                    relocation.token,
                    relocation.account,
                    relocation.amount,
                    nonce
                );

            } else {
                emit RejectRelocation(
                    chainId,
                    relocation.token,
                    relocation.account,
                    relocation.amount,
                    nonce
                );
            }
            uint256 fee = feeRefundMode == FeeRefundMode.Full ? relocation.fee : 0;
            IERC20Upgradeable(relocation.token).safeTransfer(relocation.account, relocation.amount + fee);
        } else {
            emit AbortRelocation(
                chainId,
                relocation.token,
                relocation.account,
                relocation.amount,
                nonce
            );
        }
    }

    /**
     * @dev Processes a pending relocation.
     *
     * If the relocation is executed in `BurnOrMint` mode tokens will be burnt.
     * If the relocation is executed in `LockOrTransfer` mode tokens will be locked on the bridge.
     *
     * @param chainId The destination chain ID of the relocation.
     * @param nonce The nonce of the pending relocation to process.
     */
    function _relocate(uint256 chainId, uint256 nonce) internal {
        Relocation storage storedRelocation = _relocations[chainId][nonce];
        Relocation memory relocation = storedRelocation;

        if (relocation.status == RelocationStatus.Pending) {
            storedRelocation.status = RelocationStatus.Processed;
            OperationMode mode = _relocationModes[chainId][relocation.token];

            emit Relocate(
                chainId,
                relocation.token,
                relocation.account,
                relocation.amount,
                nonce,
                mode
            );

            if (mode == OperationMode.BurnOrMint) {
                bool burningSuccess = IERC20Bridgeable(relocation.token).burnForBridging(
                    address(this),
                    relocation.amount
                );
                if (!burningSuccess) {
                    revert TokenBurningFailure();
                }
            }

            if (relocation.fee != 0) {
                IERC20Upgradeable(relocation.token).safeTransfer(_feeCollector, relocation.fee);
            }
        }
    }

    /// @dev Safely call the appropriate function from the {IERC20Bridgeable} interface.
    function _isTokenIERC20Bridgeable(address token) internal virtual returns (bool) {
        (bool success, bytes memory result) = token.staticcall(
            abi.encodeWithSelector(IERC20Bridgeable.isIERC20Bridgeable.selector)
        );
        if (success && result.length > 0) {
            return abi.decode(result, (bool));
        } else {
            return false;
        }
    }
}
