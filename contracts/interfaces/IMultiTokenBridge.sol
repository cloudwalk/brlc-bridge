// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

/**
 * @title MultiTokenBridge types interface
 * @dev See terms in the comments of the {IMultiTokenBridge} interface.
 */
interface IMultiTokenBridgeTypes {
    /**
     * @dev Enumeration for bridge operation mode
     */
    enum OperationMode {
        Unsupported,   // 0 Relocation/accommodation with certain parameters is unsupported (the default value).
        BurnOrMint,    // 1 Relocation/accommodation is supported with token burning/minting during the op.
        LockOrTransfer // 2 Relocation/accommodation is supported with token locking/transferring during the op.
    }

    /**
     * @dev Structure with data of a single token relocation.
     */
    struct Relocation {
        address token;   // The address of the token contract whose coins are being relocated.
        address account; // The account who requested the relocation.
        uint256 amount;  // The amount of tokens to relocate.
        bool canceled;   // The state of the relocation.
    }
}

/**
 * @title MultiTokenBridge interface
 * @dev A contract implementing this interface allows to bridge coins of multiple token contracts between blockchains.
 *
 * Terms that are used in relation to bridge contracts:
 *
 * - relocation -- the relocation of tokens from one chain (a source chain) to another one (a destination chain).
                   Unless otherwise stated, the source chain is the current chain.
 * - to relocate -- to move tokens from the current chain to another one.
 * - accommodation -- placing tokens coming from another chain in the current chain.
 * - to accommodate -- to meet a relocation coming from another chain and place its tokens in the current chain.
 */
interface IMultiTokenBridge is IMultiTokenBridgeTypes {
    /// @dev Emitted when a new relocation is requested by an account.
    event RequestRelocation(
        uint256 indexed chainId, // The destination chain ID of the relocation.
        address indexed token,   // The address of the token contract whose coins are being relocated.
        address indexed account, // The account who requested the relocation.
        uint256 amount,          // The amount of tokens to relocate.
        uint256 nonce            // The relocation nonce.
    );

    /// @dev Emitted when a pending relocation is canceled.
    event CancelRelocation(
        uint256 indexed chainId, // The destination chain ID of the relocation.
        address indexed token,   // The address of the token contract whose coins are being relocated.
        address indexed account, // The account who requested the relocation.
        uint256 amount,          // The amount of tokens to relocate.
        uint256 nonce            // The relocation nonce.
    );

    /// @dev Emitted when a previously requested and non-canceled relocation is processed.
    event Relocate(
        uint256 indexed chainId, // The destination chain ID of the relocation.
        address indexed token,   // The address of the token contract whose coins are being relocated.
        address indexed account, // The account who requested the relocation.
        uint256 amount,          // The amount of tokens to relocate.
        uint256 nonce,           // The relocation nonce.
        OperationMode mode       // The mode of the relocation.
    );

    /// @dev Emitted when a new accommodation takes place.
    event Accommodate(
        uint256 indexed chainId, // The source chain ID of the accommodation.
        address indexed token,   // The address of the token contract whose coins are being accommodated.
        address indexed account, // The account who requested the correspondent relocation in the source chain.
        uint256 amount,          // The amount of tokens to relocate.
        uint256 nonce,           // The accommodation nonce.
        OperationMode mode       // The mode of the accommodation.
    );

    /**
     * @dev Returns the counter of pending relocations to a destination chain with a given ID.
     * @param chainId The ID of the destination chain.
     */
    function getPendingRelocationCounter(uint256 chainId) external view returns (uint256);

    /**
     * @dev Returns the nonce of the last processed relocation to a destination chain with a given ID.
     * @param chainId The ID of the destination chain.
     */
    function getLastProcessedRelocationNonce(uint256 chainId) external view returns (uint256);

    /**
     * @dev Returns mode of relocation to a destination chain with a given ID and for a given token.
     * @param chainId The ID of the destination chain.
     * @param token The address of the token contract whose coins are being relocated.
     */
    function getRelocationMode(uint256 chainId, address token) external view returns (OperationMode);

    /**
     * @dev Returns a relocation for a given destination chain ID and nonce.
     * @param chainId The ID of the destination chain.
     * @param nonce The nonce of the relocation to return.
     */
    function getRelocation(uint256 chainId, uint256 nonce) external view returns (Relocation memory);

    /**
     * @dev Returns mode of accommodation from a source chain with a given ID and for a given token.
     * @param chainId The ID of the source chain.
     * @param token The address of the token contract whose coins are being accommodated.
     */
    function getAccommodationMode(uint256 chainId, address token) external view returns (OperationMode);

    /**
     * @dev Returns the last nonce of an accommodation from a source chain with a given ID.
     * @param chainId The ID of the source chain.
     */
    function getLastAccommodationNonce(uint256 chainId) external view returns (uint256);

    /**
     * @dev Returns the relocations for a given destination chain id and a range of nonces.
     * @param chainId The ID of the destination chain.
     * @param nonce The first nonce of the relocation range to return.
     * @param count The number of relocations in the range to return.
     * @return relocations The array of relocations for the requested range.
     */
    function getRelocations(
        uint256 chainId,
        uint256 nonce,
        uint256 count
    ) external view returns (Relocation[] memory relocations);

    /**
     * @dev Requests a new relocation with transferring tokens from an account to the bridge.
     * The new relocation will be pending until it is processed.
     * This function is expected to be called by any account.
     *
     * Emits a {RequestRelocation} event.
     *
     * @param chainId The ID of the destination chain.
     * @param token The address of the token contract whose coins are being relocated.
     * @param amount The amount of tokens to relocate.
     * @return nonce The nonce of the new relocation.
     */
    function requestRelocation(
        uint256 chainId,
        address token,
        uint256 amount
    ) external returns (uint256 nonce);

    /**
     * @dev Cancels a pending relocation with transferring tokens back from the bridge to the account.
     * This function is expected to be called by the same account who request the relocation.
     *
     * Emits a {CancelRelocation} event.
     *
     * @param chainId The destination chain ID of the relocation to cancel.
     * @param nonce The nonce of the pending relocation to cancel.
     */
    function cancelRelocation(uint256 chainId, uint256 nonce) external;

    /**
     * @dev Cancels multiple pending relocations with transferring tokens back from the bridge to the accounts.
     * This function can be called by a limited number of accounts that are allowed to execute bridge operations.
     *
     * Emits a {CancelRelocation} event for each relocation.
     *
     * @param chainId The destination chain ID of the relocations to cancel.
     * @param nonces The array of pending relocation nonces to cancel.
     */
    function cancelRelocations(uint256 chainId, uint256[] memory nonces) external;

    /**
     * @dev Processes several pending relocations.
     * Burns or locks tokens previously received from accounts specified in the pending relocations depending on
     * the operation mode of each relocation.
     * If a relocation is executed in the BurnOrMint operation mode the tokens are burnt.
     * If a relocation is executed in the LockOrTransfer operation mode the tokens are locked on the bridge account.
     * The canceled relocations are skipped during the processing.
     * This function can be called by a limited number of accounts that are allowed to execute bridge operations.
     *
     * Emits a {Relocate} event for each non-canceled relocation.
     *
     * @param chainId The destination chain ID of the pending relocations to process.
     * @param count The number of pending relocations to process.
     */
    function relocate(uint256 chainId, uint256 count) external;

    /**
     * @dev Accommodates tokens of several relocations coming from a source chain.
     * Mints or transfers tokens according to passed relocation structures depending on
     * the operation mode of each accommodation distinguished by the source chain ID and the token contract.
     * If an accommodation is executed in the BurnOrMint operation mode the tokens are minted for
     * the account mentioned in the related relocation structure.
     * If an accommodation is executed in the LockOrTransfer operation mode the tokens are transferred
     * from the bridge account to the account mentioned in the related relocation structure.
     * Tokens will be minted or transferred only for non-canceled relocations.
     * This function can be called by a limited number of accounts that are allowed to execute bridge operations.
     *
     * Emits a {Accommodate} event for each non-canceled relocation.
     *
     * @param chainId The ID of the source chain.
     * @param nonce The nonce of the first relocation to accommodate.
     * @param relocations The array of relocations to accommodate.
     */
    function accommodate(
        uint256 chainId,
        uint256 nonce,
        Relocation[] memory relocations
    ) external;
}
