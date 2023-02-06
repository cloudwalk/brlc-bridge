// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title MultiTokenBridge types interface
 * @author CloudWalk Inc.
 * @dev See terms in the comments of the {IMultiTokenBridge} interface.
 */
interface IMultiTokenBridgeTypes {
    /// @dev Enumeration of bridge operation modes.
    enum OperationMode {
        Unsupported,   // 0 Relocation/accommodation is unsupported (the default value).
        BurnOrMint,    // 1 Relocation/accommodation is supported by burning/minting tokens.
        LockOrTransfer // 2 Relocation/accommodation is supported by locking/transferring tokens.
    }

    /* @dev Enumeration of relocation statuses.
     *
     * Possible statuses changes are following:
     *
     * - Nonexistent => Pending
     * - Pending => Processed
     * - Pending => Postponed
     * - Pending => refused(Canceled or Rejected or Aborted)
     * - Postponed => refused(Canceled or Rejected or Aborted)
     * - Postponed => Continued
     */
    enum RelocationStatus {
        Nonexistent, // 0 The relocation does not exist.
        Pending,     // 1 The status right after the relocation is requested.
        Canceled,    // 2 The relocation has been canceled by the user decision. Tokens are returned to the user.
        Processed,   // 3 The relocation has been successfully processed and accommodated in the destination chain.
        Rejected,    // 4 The relocation has been rejected by the brider decision. Tokens are returned to the user.
        Aborted,     // 5 The relocation has been aborted. Tokens are not returned to the user.
        Postponed,   // 6 The relocation has been postponed. It might be continued as a new relocation.
        Continued    // 7 The relocation has been continued as a new relocation with a new nonce.
    }

    /// @dev Enumeration of fee refund modes.
    enum FeeRefundMode {
        Nothing, // 0 No fee is refunded.
        Full     // 1 The full fee is refunded.
    }

    /// @dev Structure with data of a single relocation operation.
    struct Relocation {
        address token;           // The address of the token used for relocation.
        address account;         // The account that requested the relocation.
        uint256 amount;          // The amount of tokens to relocate.
        RelocationStatus status; // The current status of the relocation.
        uint256 oldNonce;        // The nonce of the replaced relocation or zero.
        uint256 newNonce;        // The nonce of the relocation that replaces this one to continue it or zero.
        uint256 fee;             // The result fee that was taken from the initiator account for the relocation.
    }

    /// @dev Structure with data of a single accommodation operation that matches a relocation in the source chain.
    struct Accommodation {
        address token;           // The address of the token used for accommodation.
        address account;         // The account that requested the relocation in the source chain.
        uint256 amount;          // The amount of tokens to accommodate.
        RelocationStatus status; // The status of the corresponding relocation.
    }
}

/**
 * @title MultiTokenBridge interface
 * @author CloudWalk Inc.
 * @dev The bridge contract interface that supports bridging of multiple tokens.
 *
 * Terms used in the context of bridge contract operations:
 *
 * - relocation -- the relocation of tokens from one chain (a source chain) to another one (a destination chain).
 * - to relocate -- to move tokens from the current chain to another one.
 * - accommodation -- placing tokens from another chain in the current chain.
 * - to accommodate -- to meet a relocation coming from another chain and place tokens in the current chain.
 */
interface IMultiTokenBridge is IMultiTokenBridgeTypes {
    /// @dev Emitted when a new relocation is requested.
    event RequestRelocation(
        uint256 indexed chainId, // The destination chain ID of the relocation.
        address indexed token,   // The address of the token used for relocation.
        address indexed account, // The account that requested the relocation.
        uint256 amount,          // The amount of tokens to relocate.
        uint256 nonce,           // The relocation nonce.
        uint256 fee              // The fee taken for the relocation.
    );

    /// @dev Emitted when the relocation is canceled.
    event CancelRelocation(
        uint256 indexed chainId, // See the same field of the {RequestRelocation} event.
        address indexed token,   // See the same field of the {RequestRelocation} event.
        address indexed account, // See the same field of the {RequestRelocation} event.
        uint256 amount,          // See the same field of the {RequestRelocation} event.
        uint256 nonce,           // See the same field of the {RequestRelocation} event.
        uint256 refundedFee      // The fee amount that is refunded to the relocation initiator account.
    );

    /// @dev Emitted when the relocation is rejected.
    event RejectRelocation(
        uint256 indexed chainId, // See the same field of the {RequestRelocation} event.
        address indexed token,   // See the same field of the {RequestRelocation} event.
        address indexed account, // See the same field of the {RequestRelocation} event.
        uint256 amount,          // See the same field of the {RequestRelocation} event.
        uint256 nonce,           // See the same field of the {RequestRelocation} event.
        uint256 refundedFee      // The fee amount that is refunded to the relocation initiator account.
    );

    /// @dev Emitted when the relocation is aborted. The fields are the same as for the {RequestRelocation} event.
    event AbortRelocation(
        uint256 indexed chainId,
        address indexed token,
        address indexed account,
        uint256 amount,
        uint256 nonce
    );

    /// @dev Emitted when the relocation is postponed. The fields are the same as for the {RequestRelocation} event.
    event PostponeRelocation(
        uint256 indexed chainId,
        address indexed token,
        address indexed account,
        uint256 amount,
        uint256 nonce
    );

    /// @dev Emitted when a postponed relocation is continued as a new one.
    event ContinueRelocation(
        uint256 indexed chainId, // See the same field of the {RequestRelocation} event.
        address indexed token,   // See the same field of the {RequestRelocation} event.
        address indexed account, // See the same field of the {RequestRelocation} event.
        uint256 amount,          // See the same field of the {RequestRelocation} event.
        uint256 oldNonce,        // The previous relocation nonce.
        uint256 newNonce         // The nonce on the new relocation.
    );

    /// @dev Emitted when a previously requested relocation is processed and accommodated in the destination chain.
    event Relocate(
        uint256 indexed chainId, // See the same field of the {RequestRelocation} event.
        address indexed token,   // See the same field of the {RequestRelocation} event.
        address indexed account, // See the same field of the {RequestRelocation} event.
        uint256 amount,          // See the same field of the {RequestRelocation} event.
        uint256 nonce,           // See the same field of the {RequestRelocation} event.
        OperationMode mode       // The mode of relocation.
    );

    /// @dev Emitted when a new accommodation takes place.
    event Accommodate(
        uint256 indexed chainId, // The source chain ID of the accommodation.
        address indexed token,   // The address of the token used for accommodation.
        address indexed account, // The account that requested the correspondent relocation in the source chain.
        uint256 amount,          // The amount of tokens to accommodate.
        uint256 nonce,           // The nonce of the corresponded relocation in the source chain.
        OperationMode mode       // The mode of accommodation.
    );

    /**
     * @dev Returns the counter of pending relocations for a given destination chain.
     * @param chainId The ID of the destination chain.
     */
    function getPendingRelocationCounter(uint256 chainId) external view returns (uint256);

    /**
     * @dev Returns the last processed relocation nonce for a given destination chain.
     * @param chainId The ID of the destination chain.
     */
    function getLastProcessedRelocationNonce(uint256 chainId) external view returns (uint256);

    /**
     * @dev Returns a relocation mode for a given destination chain and token.
     * @param chainId The ID of the destination chain.
     * @param token The address of the token.
     */
    function getRelocationMode(uint256 chainId, address token) external view returns (OperationMode);

    /**
     * @dev Returns relocation details for a given destination chain and nonce.
     * @param chainId The ID of the destination chain.
     * @param nonce The nonce of the relocation to return.
     */
    function getRelocation(uint256 chainId, uint256 nonce) external view returns (Relocation memory);

    /**
     * @dev Returns an accommodation mode for a given source chain and token.
     * @param chainId The ID of the source chain.
     * @param token The address of the token.
     */
    function getAccommodationMode(uint256 chainId, address token) external view returns (OperationMode);

    /**
     * @dev Returns the last accommodation nonce for a given source chain.
     * @param chainId The ID of the source chain.
     */
    function getLastAccommodationNonce(uint256 chainId) external view returns (uint256);

    /**
     * @dev Returns relocation details for a given destination chain and a range of nonces.
     * @param chainId The ID of the destination chain.
     * @param nonce The nonce of the first relocation to return.
     * @param count The number of relocations in the range to return.
     * @return relocations The array of relocations for the requested range.
     */
    function getRelocations(
        uint256 chainId,
        uint256 nonce,
        uint256 count
    ) external view returns (Relocation[] memory relocations);

    /**
     * @dev Returns the address of the bridge fee oracle contract.
     */
    function feeOracle() external view returns (address);

    /**
     * @dev Returns the address to collect relocation fees.
     */
    function feeCollector() external view returns (address);

    /**
     * @dev Defines if fee taken for relocations.
     */
    function isFeeTaken() external view returns (bool);

    /**
     * @dev Requests a new relocation with transferring tokens from an account to the bridge.
     *
     * The new relocation will be pending until it is processed.
     * This function is expected to be called by any account.
     *
     * Emits a {RequestRelocation} event.
     *
     * @param chainId The ID of the destination chain.
     * @param token The address of the token used for relocation.
     * @param amount The amount of tokens to relocate.
     * @return nonce The nonce of the new relocation.
     */
    function requestRelocation(
        uint256 chainId,
        address token,
        uint256 amount
    ) external returns (uint256 nonce);

    /**
     * @dev Cancels a pending relocation with transferring tokens back from the bridge to the initiator account.
     *
     * Transfers the relocation tokens back from the bridge to the initiator account.
     * This function can be called by a limited number of accounts that are allowed to execute bridging operations.
     *
     * Emits a {ChangeRelocationStatus} event.
     *
     * @param chainId The destination chain ID of the relocation to cancel.
     * @param nonce The nonce of the pending relocation to cancel.
     * @param feeRefundMode A mode of the fee refund during the cancellation.
     */
    function cancelRelocation(uint256 chainId, uint256 nonce, FeeRefundMode feeRefundMode) external;

    /**
     * @dev Processes specified count of pending relocations.
     *
     * If relocations are executed in `BurnOrMint` mode tokens will be burnt.
     * If relocations are executed in `LockOrTransfer` mode tokens will be locked on the bridge.
     * The canceled relocations are skipped during the processing.
     * This function can be called by a limited number of accounts that are allowed to execute bridging operations.
     *
     * Emits a {Relocate} event for each non-canceled relocation.
     *
     * @param chainId The destination chain ID of the pending relocations.
     * @param count The number of pending relocations to process.
     */
    function relocate(uint256 chainId, uint256 count) external;

    /**
     * @dev Rejects a pending relocation.
     *
     * Transfers the relocation tokens back from the bridge to the initiator account.
     * This function can be called by a limited number of accounts that are allowed to execute bridging operations.
     *
     * Emits a {ChangeRelocationStatus} event.
     *
     * @param chainId The destination chain ID of the relocation to reject.
     * @param nonce The nonce of the relocation to reject.
     * @param feeRefundMode A mode of the fee refund during the rejection.
     */
    function rejectRelocation(uint256 chainId, uint256 nonce, FeeRefundMode feeRefundMode) external;

    /**
     * @dev Aborts a pending relocation.
     *
     * Does not return the amount and the fee to the user.
     * This function can be called by a limited number of accounts that are allowed to execute bridging operations.
     *
     * Emits a {ChangeRelocationStatus} event.
     *
     * @param chainId The destination chain ID of the relocation to abort.
     * @param nonce The nonce of the relocation to abort.
     */
    function abortRelocation(uint256 chainId, uint256 nonce) external;

    /**
     * @dev Postpones a pending relocation.
     *
     * This function can be called by a limited number of accounts that are allowed to execute bridging operations.
     *
     * Emits a {ChangeRelocationStatus} event.
     *
     * @param chainId The destination chain ID of the relocation to reject.
     * @param nonce The nonce of the relocation to reject.
     */
    function postponeRelocation(uint256 chainId, uint256 nonce) external;

    /**
     * @dev Continues a previously postponed relocation.
     *
     * The relocation is replaced with a new one with a new nonce.
     * This function can be called by a limited number of accounts that are allowed to execute bridging operations.
     *
     * Emits a {ContinueRelocation} event.
     *
     * @param chainId The destination chain ID of the relocation to reject.
     * @param nonce The nonce of the relocation to reject.
     */
    function continueRelocation(uint256 chainId, uint256 nonce) external;

    /**
     * @dev Accommodates tokens from a source chain.
     *
     * If accommodations are executed in `BurnOrMint` mode tokens will be minted.
     * If accommodations are executed in `LockOrTransfer` mode tokens will be transferred from the bridge account.
     * Tokens will be minted or transferred only for non-canceled relocations.
     * This function can be called by a limited number of accounts that are allowed to execute bridging operations.
     *
     * Emits a {Accommodate} event for each non-canceled relocation.
     *
     * @param chainId The ID of the source chain.
     * @param nonce The nonce of the first relocation to accommodate.
     * @param accommodations The array of structures with accommodation data.
     */
    function accommodate(
        uint256 chainId,
        uint256 nonce,
        Accommodation[] calldata accommodations
    ) external;
}
