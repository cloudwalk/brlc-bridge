import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createRevertMessageDueToMissingRole } from "../test-utils/misc";

enum OperationMode {
  Unsupported = 0,
  BurnOrMint = 1,
  LockOrTransfer = 2,
}

interface TestTokenRelocation {
  chainId: number;
  token: Contract;
  account: SignerWithAddress;
  amount: number;
  nonce: number;
  requested?: boolean;
  processed?: boolean;
  canceled?: boolean;
}

interface OnChainRelocation {
  token: string;
  account: string;
  amount: BigNumber;
  canceled: boolean;
}

const defaultOnChainRelocation: OnChainRelocation = {
  token: ethers.constants.AddressZero,
  account: ethers.constants.AddressZero,
  amount: ethers.constants.Zero,
  canceled: false,
};

interface BridgeStateForChainId {
  requestedRelocationCount: number;
  processedRelocationCount: number;
  pendingRelocationCount: number;
  firstNonce: number;
  nonceCount: number;
  onChainRelocations: OnChainRelocation[];
}

function toOnChainRelocation(relocation: TestTokenRelocation): OnChainRelocation {
  return {
    token: relocation.token.address,
    account: relocation.account.address,
    amount: BigNumber.from(relocation.amount),
    canceled: relocation.canceled || false,
  };
}

function checkEquality(
  actualOnChainRelocation: any,
  expectedRelocation: OnChainRelocation,
  relocationIndex: number,
  chainId: number
) {
  expect(actualOnChainRelocation.token).to.equal(
    expectedRelocation.token,
    `relocation[${relocationIndex}].token is incorrect, chainId=${chainId}`
  );
  expect(actualOnChainRelocation.account).to.equal(
    expectedRelocation.account,
    `relocation[${relocationIndex}].account is incorrect, chainId=${chainId}`
  );
  expect(actualOnChainRelocation.amount).to.equal(
    expectedRelocation.amount,
    `relocation[${relocationIndex}].amount is incorrect, chainId=${chainId}`
  );
  expect(actualOnChainRelocation.canceled).to.equal(
    expectedRelocation.canceled,
    `relocation[${relocationIndex}].canceled is incorrect, chainId=${chainId}`
  );
}

function countRelocationsForChainId(relocations: TestTokenRelocation[], targetChainId: number) {
  return countNumberArrayTotal(
    relocations.map(
      function (relocation: TestTokenRelocation): number {
        return (relocation.chainId == targetChainId) ? 1 : 0;
      }
    )
  );
}

function markRelocationsAsProcessed(relocations: TestTokenRelocation[]) {
  relocations.forEach((relocation: TestTokenRelocation) => relocation.processed = true);
}

function getAmountByTokenAndAddresses(
  relocations: TestTokenRelocation[],
  targetToken: Contract,
  addresses: string[]
): number[] {
  const totalAmountPerAddress: Map<string, number> = new Map<string, number>();
  relocations.forEach(relocation => {
    const address = relocation.account.address;
    let totalAmount = totalAmountPerAddress.get(address) || 0;
    if (relocation.token == targetToken && !relocation.canceled) {
      totalAmount += relocation.amount;
    }
    totalAmountPerAddress.set(address, totalAmount);
  });
  return addresses.map((address: string) => totalAmountPerAddress.get(address) || 0);
}

describe("Contract 'MultiTokenBridge'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_RELOCATION_TOKEN_ADDRESS_IS_ZERO = "ZeroRelocationToken";
  const REVERT_ERROR_IF_RELOCATION_AMOUNT_IS_ZERO = "ZeroRelocationAmount";
  const REVERT_ERROR_IF_RELOCATION_COUNT_IS_ZERO = "ZeroRelocationCount";
  const REVERT_ERROR_IF_LACK_OF_PENDING_RELOCATIONS = "LackOfPendingRelocations";
  const REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED = "UnsupportedRelocation";
  const REVERT_ERROR_IF_RELOCATION_IS_NOT_EXISTENT = "NotExistentRelocation";
  const REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED = "AlreadyProcessedRelocation";
  const REVERT_ERROR_IF_RELOCATION_IS_ALREADY_CANCELED = "AlreadyCanceledRelocation";
  const REVERT_ERROR_IF_CANCELLATION_ARRAY_OF_NONCES_IS_EMPTY = "EmptyCancellationNoncesArray";
  const REVERT_ERROR_IF_TX_SENDER_IS_UNAUTHORIZED_TO_CANCEL_RELOCATION = "UnauthorizedCancellation";

  const REVERT_ERROR_IF_ACCOMMODATION_NONCE_IS_ZERO = "ZeroAccommodationNonce";
  const REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH = "AccommodationNonceMismatch";
  const REVERT_ERROR_IF_ACCOMMODATION_ARRAY_OF_RELOCATIONS_IS_EMPTY = "EmptyAccommodationRelocationsArray";
  const REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED = "UnsupportedAccommodation";
  const REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS = "ZeroAccommodationAccount";
  const REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO = "ZeroAccommodationAmount";

  const REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED = "TokenMintingFailure";
  const REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED = "TokenBurningFailure";

  const REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE = "NonBridgeableToken";
  const REVERT_ERROR_IF_RELOCATION_MODE_HAS_NOT_BEEN_CHANGED = "UnchangedRelocationMode";
  const REVERT_ERROR_IF_ACCOMMODATION_MODE_HAS_NOT_BEEN_CHANGED = "UnchangedAccommodationMode";

  let multiTokenBridge: Contract;
  let fakeTokenAddress: string;
  let deployer: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let ownerRole: string;
  let pauserRole: string;
  let rescuerRole: string;
  let bridgerRole: string;
  let operationMode: OperationMode;

  async function deployTokenMock(serialNumber: number): Promise<Contract> {
    const name = "BRL Coin " + serialNumber;
    const symbol = "BRLC" + serialNumber;
    const TokenMock: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    const tokenMock: Contract = await TokenMock.deploy();
    await tokenMock.deployed();
    await proveTx(tokenMock.initialize(name, symbol));

    // Set the supported bridge of the token if it is needed
    if (operationMode == OperationMode.BurnOrMint) {
      await proveTx(tokenMock.setBridge(multiTokenBridge.address));
      expect(await tokenMock.isBridgeSupported(multiTokenBridge.address)).to.equal(true);
    }
    return tokenMock;
  }

  async function setUpContractsForRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      const relocationMode: OperationMode = await multiTokenBridge.getRelocationMode(
        relocation.chainId,
        relocation.token.address
      );
      if (relocationMode !== operationMode) {
        await proveTx(
          multiTokenBridge.setRelocationMode(
            relocation.chainId,
            relocation.token.address,
            operationMode
          )
        );
      }
      await proveTx(relocation.token.mint(relocation.account.address, relocation.amount));
      const allowance: BigNumber =
        await relocation.token.allowance(relocation.account.address, multiTokenBridge.address);
      if (allowance.lt(BigNumber.from(ethers.constants.MaxUint256))) {
        await proveTx(
          relocation.token.connect(relocation.account).approve(
            multiTokenBridge.address,
            ethers.constants.MaxUint256
          )
        );
      }
    }
  }

  async function requestRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        multiTokenBridge.connect(relocation.account).requestRelocation(
          relocation.chainId,
          relocation.token.address,
          relocation.amount)
      );
      relocation.requested = true;
    }
  }

  async function pauseMultiTokenBridge() {
    await proveTx(multiTokenBridge.grantRole(pauserRole, deployer.address));
    await proveTx(multiTokenBridge.pause());
  }

  async function setBridgerRole(account: SignerWithAddress) {
    await proveTx(multiTokenBridge.grantRole(bridgerRole, account.address));
  }

  async function cancelRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        multiTokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce)
      );
      relocation.canceled = true;
    }
  }

  function defineExpectedChainIds(relocations: TestTokenRelocation[]): Set<number> {
    const expectedChainIds: Set<number> = new Set<number>();

    relocations.forEach((relocation: TestTokenRelocation) => {
      expectedChainIds.add(relocation.chainId);
    });

    return expectedChainIds;
  }

  function defineExpectedTokens(relocations: TestTokenRelocation[]): Set<Contract> {
    const expectedTokens: Set<Contract> = new Set<Contract>();

    relocations.forEach((relocation: TestTokenRelocation) => {
      expectedTokens.add(relocation.token);
    });

    return expectedTokens;
  }

  function defineExpectedBridgeStateForSingleChainId(
    chainId: number,
    relocations: TestTokenRelocation[]
  ): BridgeStateForChainId {
    const expectedBridgeState: BridgeStateForChainId = {
      requestedRelocationCount: 0,
      processedRelocationCount: 0,
      pendingRelocationCount: 0,
      firstNonce: 0,
      nonceCount: 1,
      onChainRelocations: [defaultOnChainRelocation]
    };
    expectedBridgeState.requestedRelocationCount = countNumberArrayTotal(
      relocations.map(
        function (relocation: TestTokenRelocation): number {
          return !!relocation.requested && relocation.chainId == chainId ? 1 : 0;
        }
      )
    );

    expectedBridgeState.processedRelocationCount = countNumberArrayTotal(
      relocations.map(
        function (relocation: TestTokenRelocation): number {
          return !!relocation.processed && relocation.chainId == chainId ? 1 : 0;
        }
      )
    );

    relocations.forEach((relocation: TestTokenRelocation) => {
      if (!!relocation.requested && relocation.chainId == chainId) {
        expectedBridgeState.onChainRelocations[relocation.nonce] = toOnChainRelocation(relocation);
      }
    });
    expectedBridgeState.onChainRelocations[expectedBridgeState.onChainRelocations.length] = defaultOnChainRelocation;
    expectedBridgeState.nonceCount = expectedBridgeState.onChainRelocations.length;

    expectedBridgeState.pendingRelocationCount =
      expectedBridgeState.requestedRelocationCount - expectedBridgeState.processedRelocationCount;

    return expectedBridgeState;
  }

  function defineExpectedBridgeStatesPerChainId(
    relocations: TestTokenRelocation[]
  ): Map<number, BridgeStateForChainId> {
    const expectedChainIds: Set<number> = defineExpectedChainIds(relocations);
    const expectedStatesByChainId: Map<number, BridgeStateForChainId> = new Map<number, BridgeStateForChainId>();

    expectedChainIds.forEach((chainId: number) => {
      const expectedBridgeState: BridgeStateForChainId =
        defineExpectedBridgeStateForSingleChainId(chainId, relocations);
      expectedStatesByChainId.set(chainId, expectedBridgeState);
    });

    return expectedStatesByChainId;
  }

  function defineExpectedBridgeBalancesPerTokens(relocations: TestTokenRelocation[]): Map<Contract, number> {
    const expectedTokens: Set<Contract> = defineExpectedTokens(relocations);
    const expectedBridgeBalancesPerToken: Map<Contract, number> = new Map<Contract, number>();

    expectedTokens.forEach((token: Contract) => {
      const expectedBalance: number = countNumberArrayTotal(
        relocations.map(
          function (relocation: TestTokenRelocation): number {
            if (relocation.token == token
              && !!relocation.requested
              && (operationMode === OperationMode.LockOrTransfer || !relocation.processed)
              && !relocation.canceled
            ) {
              return relocation.amount;
            } else {
              return 0;
            }
          }
        )
      );
      expectedBridgeBalancesPerToken.set(token, expectedBalance);
    });
    return expectedBridgeBalancesPerToken;
  }

  async function checkBridgeStatesPerChainId(expectedBridgeStatesByChainId: Map<number, BridgeStateForChainId>) {
    for (const expectedChainId of expectedBridgeStatesByChainId.keys()) {
      const expectedBridgeState: BridgeStateForChainId | undefined = expectedBridgeStatesByChainId.get(expectedChainId);
      if (!expectedBridgeState) {
        continue;
      }
      expect(
        await multiTokenBridge.getPendingRelocationCounter(expectedChainId)
      ).to.equal(
        expectedBridgeState.pendingRelocationCount,
        `Wrong pending relocation count, chainId=${expectedChainId}`
      );
      expect(
        await multiTokenBridge.getLastProcessedRelocationNonce(expectedChainId)
      ).to.equal(
        expectedBridgeState.processedRelocationCount,
        `Wrong requested relocation count, chainId=${expectedChainId}`
      );
      const actualRelocations = await multiTokenBridge.getRelocations(
        expectedChainId,
        expectedBridgeState.firstNonce,
        expectedBridgeState.nonceCount
      );
      expect(actualRelocations.length).to.equal(expectedBridgeState.onChainRelocations.length);
      for (let i = 0; i < expectedBridgeState.onChainRelocations.length; ++i) {
        const onChainRelocation: OnChainRelocation = expectedBridgeState.onChainRelocations[i];
        checkEquality(actualRelocations[i], onChainRelocation, i, expectedChainId);
      }
    }
  }

  async function checkRelocationStructures(relocations: TestTokenRelocation[]) {
    for (let i = 0; i < relocations.length; ++i) {
      const relocation = relocations[i];
      if (relocation.requested) {
        const actualRelocation = await multiTokenBridge.getRelocation(relocation.chainId, relocation.nonce);
        checkEquality(actualRelocation, toOnChainRelocation(relocation), i, relocation.chainId);
      }
    }
  }

  async function checkBridgeBalancesPerToken(expectedBalancesPerToken: Map<Contract, number>) {
    for (const expectedToken of expectedBalancesPerToken.keys()) {
      const expectedBalance: number | undefined = expectedBalancesPerToken.get(expectedToken);
      if (!expectedBalance) {
        continue;
      }
      const tokenSymbol = await expectedToken.symbol();
      expect(
        await expectedToken.balanceOf(multiTokenBridge.address)
      ).to.equal(
        expectedBalance,
        `Balance is wrong for token with symbol ${tokenSymbol}`
      );
    }
  }

  async function checkBridgeState(relocations: TestTokenRelocation[]): Promise<void> {
    const expectedBridgeStatesByChainId: Map<number, BridgeStateForChainId> =
      defineExpectedBridgeStatesPerChainId(relocations);
    const expectedBridgeBalancesPerToken: Map<Contract, number> = defineExpectedBridgeBalancesPerTokens(relocations);

    await checkBridgeStatesPerChainId(expectedBridgeStatesByChainId);
    await checkRelocationStructures(relocations);
    await checkBridgeBalancesPerToken(expectedBridgeBalancesPerToken);
  }

  beforeEach(async () => {
    // Deploy TokenBridge
    const MultiTokenBridge: ContractFactory = await ethers.getContractFactory("MultiTokenBridge");
    multiTokenBridge = await MultiTokenBridge.deploy();
    await multiTokenBridge.deployed();
    await proveTx(multiTokenBridge.initialize());

    // Get user accounts
    [deployer, user1, user2] = await ethers.getSigners();

    // Roles
    ownerRole = (await multiTokenBridge.OWNER_ROLE()).toLowerCase();
    pauserRole = (await multiTokenBridge.PAUSER_ROLE()).toLowerCase();
    rescuerRole = (await multiTokenBridge.RESCUER_ROLE()).toLowerCase();
    bridgerRole = (await multiTokenBridge.BRIDGER_ROLE()).toLowerCase();

    fakeTokenAddress = user1.address;
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(
      multiTokenBridge.initialize()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The role admins
    expect(await multiTokenBridge.getRoleAdmin(ownerRole)).to.equal(ownerRole);
    expect(await multiTokenBridge.getRoleAdmin(pauserRole)).to.equal(ownerRole);
    expect(await multiTokenBridge.getRoleAdmin(rescuerRole)).to.equal(ownerRole);
    expect(await multiTokenBridge.getRoleAdmin(bridgerRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await multiTokenBridge.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await multiTokenBridge.hasRole(pauserRole, deployer.address)).to.equal(false);
    expect(await multiTokenBridge.hasRole(rescuerRole, deployer.address)).to.equal(false);
    expect(await multiTokenBridge.hasRole(bridgerRole, deployer.address)).to.equal(false);

    // The initial contract state is unpaused
    expect(await multiTokenBridge.paused()).to.equal(false);
  });

  describe("Configuration", async () => {
    let tokenMock: Contract;

    beforeEach(async () => {
      operationMode = OperationMode.Unsupported;
      tokenMock = await deployTokenMock(1);
    });

    describe("Function 'setRelocationMode()'", async () => {
      const chainId = 123;

      it("Is reverted if is called not by the account with the owner role", async () => {
        await expect(
          multiTokenBridge.connect(user1).setRelocationMode(
            chainId,
            tokenMock.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        await expect(
          multiTokenBridge.setRelocationMode(
            chainId,
            fakeTokenAddress,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE);
      });

      it("Emits the correct events and updates the configuration correctly", async () => {
        const relocationModeOld: OperationMode = await multiTokenBridge.getRelocationMode(chainId, tokenMock.address);
        expect(relocationModeOld).to.equal(OperationMode.Unsupported);
        await expect(
          multiTokenBridge.setRelocationMode(
            chainId,
            tokenMock.address,
            OperationMode.BurnOrMint
          )
        ).to.emit(
          multiTokenBridge,
          "SetRelocationMode"
        ).withArgs(
          chainId,
          tokenMock.address,
          OperationMode.Unsupported,
          OperationMode.BurnOrMint
        );
        const relocationModeNew: OperationMode = await multiTokenBridge.getRelocationMode(chainId, tokenMock.address);
        expect(relocationModeNew).to.equal(OperationMode.BurnOrMint);

        await expect(
          multiTokenBridge.setRelocationMode(
            chainId,
            tokenMock.address,
            OperationMode.LockOrTransfer
          )
        ).to.emit(
          multiTokenBridge,
          "SetRelocationMode"
        ).withArgs(
          chainId,
          tokenMock.address,
          OperationMode.BurnOrMint,
          OperationMode.LockOrTransfer
        );
        const relocationModeNew2: OperationMode = await multiTokenBridge.getRelocationMode(chainId, tokenMock.address);
        expect(relocationModeNew2).to.equal(OperationMode.LockOrTransfer);

        await expect(
          multiTokenBridge.setRelocationMode(
            chainId,
            tokenMock.address,
            OperationMode.Unsupported
          )
        ).to.emit(
          multiTokenBridge,
          "SetRelocationMode"
        ).withArgs(
          chainId,
          tokenMock.address,
          OperationMode.LockOrTransfer,
          OperationMode.Unsupported
        );
        const relocationModeNew3: OperationMode = await multiTokenBridge.getRelocationMode(chainId, tokenMock.address);
        expect(relocationModeNew3).to.equal(OperationMode.Unsupported);
      });

      it("Is reverted if the call does not changed the relocation supporting state", async () => {
        await expect(
          multiTokenBridge.setRelocationMode(
            chainId,
            tokenMock.address,
            OperationMode.Unsupported
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_MODE_HAS_NOT_BEEN_CHANGED
        );

        await proveTx(multiTokenBridge.setRelocationMode(
          chainId,
          tokenMock.address,
          OperationMode.BurnOrMint
        ));

        await expect(
          multiTokenBridge.setRelocationMode(
            chainId,
            tokenMock.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_MODE_HAS_NOT_BEEN_CHANGED
        );
      });
    });

    describe("Function 'setAccommodationMode()'", async () => {
      const chainId = 123;

      it("Is reverted if is called not by the account with the owner role", async () => {
        await expect(
          multiTokenBridge.connect(user1).setAccommodationMode(
            chainId,
            tokenMock.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        await expect(
          multiTokenBridge.setAccommodationMode(
            chainId,
            fakeTokenAddress,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE);
      });

      it("Emits the correct events and updates the configuration correctly", async () => {
        const accommodationModeOld: OperationMode =
          await multiTokenBridge.getAccommodationMode(chainId, tokenMock.address);
        expect(accommodationModeOld).to.equal(OperationMode.Unsupported);
        await expect(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock.address,
            OperationMode.BurnOrMint
          )
        ).to.emit(
          multiTokenBridge,
          "SetAccommodationMode"
        ).withArgs(
          chainId,
          tokenMock.address,
          OperationMode.Unsupported,
          OperationMode.BurnOrMint
        );
        const accommodationModeNew: OperationMode =
          await multiTokenBridge.getAccommodationMode(chainId, tokenMock.address);
        expect(accommodationModeNew).to.equal(OperationMode.BurnOrMint);

        await expect(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock.address,
            OperationMode.LockOrTransfer
          )
        ).to.emit(
          multiTokenBridge,
          "SetAccommodationMode"
        ).withArgs(
          chainId,
          tokenMock.address,
          OperationMode.BurnOrMint,
          OperationMode.LockOrTransfer
        );
        const accommodationModeNew2: OperationMode =
          await multiTokenBridge.getAccommodationMode(chainId, tokenMock.address);
        expect(accommodationModeNew2).to.equal(OperationMode.LockOrTransfer);

        await expect(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock.address,
            OperationMode.Unsupported
          )
        ).to.emit(
          multiTokenBridge,
          "SetAccommodationMode"
        ).withArgs(
          chainId,
          tokenMock.address,
          OperationMode.LockOrTransfer,
          OperationMode.Unsupported
        );
        const accommodationModeNew3: OperationMode =
          await multiTokenBridge.getAccommodationMode(chainId, tokenMock.address);
        expect(accommodationModeNew3).to.equal(OperationMode.Unsupported);
      });

      it("Is reverted if the call does not changed the accommodation supporting state", async () => {
        await expect(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock.address,
            OperationMode.Unsupported
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_ACCOMMODATION_MODE_HAS_NOT_BEEN_CHANGED
        );

        await proveTx(multiTokenBridge.setAccommodationMode(
          chainId,
          tokenMock.address,
          OperationMode.BurnOrMint
        ));

        await expect(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_ACCOMMODATION_MODE_HAS_NOT_BEEN_CHANGED
        );
      });
    });
  });

  describe("Interactions related to relocations in the BurnOrMint operation mode", async () => {
    let tokenMock1: Contract;

    beforeEach(async () => {
      operationMode = OperationMode.BurnOrMint;
      tokenMock1 = await deployTokenMock(1);
    });

    describe("Function 'requestRelocation()'", async () => {
      let relocation: TestTokenRelocation;

      beforeEach(async () => {
        relocation = {
          chainId: 123,
          token: tokenMock1,
          account: user1,
          amount: 456,
          nonce: 1,
        };
        await setUpContractsForRelocations([relocation]);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseMultiTokenBridge();
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            relocation.amount
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the token address is zero", async () => {
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            ethers.constants.AddressZero,
            relocation.amount
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_TOKEN_ADDRESS_IS_ZERO);
      });

      it("Is reverted if the token amount of the relocation is zero", async () => {
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            0
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_AMOUNT_IS_ZERO);
      });

      it("Is reverted if the target chain is unsupported for relocations", async () => {
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId + 1,
            relocation.token.address,
            relocation.amount
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the token is unsupported for relocations", async () => {
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            fakeTokenAddress,
            relocation.amount
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the user has not enough token balance", async () => {
        const excessTokenAmount: number = relocation.amount + 1;
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            excessTokenAmount
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
        await checkBridgeState([relocation]);
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            relocation.amount
          )
        ).to.changeTokenBalances(
          relocation.token,
          [multiTokenBridge, relocation.account],
          [+relocation.amount, -relocation.amount,]
        ).and.to.emit(
          multiTokenBridge,
          "RequestRelocation"
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce
        );
        relocation.requested = true;
        await checkBridgeState([relocation]);
      });
    });

    describe("Function 'cancelRelocation()'", async () => {
      let relocation: TestTokenRelocation;

      beforeEach(async () => {
        relocation = {
          chainId: 234,
          token: tokenMock1,
          account: user1,
          amount: 567,
          nonce: 1,
        };
        await setUpContractsForRelocations([relocation]);
        await requestRelocations([relocation]);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseMultiTokenBridge();
        await expect(
          multiTokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller did not request the relocation", async () => {
        await expect(
          multiTokenBridge.connect(user2).cancelRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_TX_SENDER_IS_UNAUTHORIZED_TO_CANCEL_RELOCATION
        );
      });

      it("Is reverted if a relocation with the nonce has already processed", async () => {
        await expect(
          multiTokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce - 1)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_TX_SENDER_IS_UNAUTHORIZED_TO_CANCEL_RELOCATION
        );
      });

      it("Is reverted if a relocation with the nonce does not exists", async () => {
        await expect(
          multiTokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce + 1)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_TX_SENDER_IS_UNAUTHORIZED_TO_CANCEL_RELOCATION
        );
      });

      it("Transfers the tokens as expected, emits the correct event, changes the state properly", async () => {
        await checkBridgeState([relocation]);
        await expect(
          multiTokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account],
          [-relocation.amount, +relocation.amount]
        ).and.to.emit(
          multiTokenBridge,
          "CancelRelocation"
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce
        );
        relocation.canceled = true;
        await checkBridgeState([relocation]);
      });
    });

    describe("Function 'cancelRelocations()'", async () => {
      const chainId = 12;

      let tokenMock2: Contract;
      let relocations: TestTokenRelocation[];
      let relocator: SignerWithAddress;
      let relocationNonces: number[];

      beforeEach(async () => {
        tokenMock2 = await deployTokenMock(2);

        relocations = [
          {
            chainId: chainId,
            token: tokenMock1,
            account: user1,
            amount: 34,
            nonce: 1,
          },
          {
            chainId: chainId,
            token: tokenMock2,
            account: user2,
            amount: 56,
            nonce: 2,
          },
        ];
        relocationNonces = relocations.map((relocation: TestTokenRelocation) => relocation.nonce);
        relocator = user2;
        await setUpContractsForRelocations(relocations);
        await requestRelocations(relocations);
        await setBridgerRole(relocator);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseMultiTokenBridge();
        await expect(
          multiTokenBridge.connect(relocator).cancelRelocations(chainId, relocationNonces)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await expect(
          multiTokenBridge.connect(deployer).cancelRelocations(chainId, relocationNonces)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, bridgerRole));
      });

      it("Is reverted if the input array of nonces is empty", async () => {
        await expect(
          multiTokenBridge.connect(relocator).cancelRelocations(chainId, [])
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_CANCELLATION_ARRAY_OF_NONCES_IS_EMPTY);
      });

      it("Is reverted if some input nonce is less than the lowest nonce of pending relocations", async () => {
        await expect(multiTokenBridge.connect(relocator).cancelRelocations(
          chainId,
          [
            Math.min(...relocationNonces),
            Math.min(...relocationNonces) - 1,
          ]
        )).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED);
      });

      it("Is reverted if some input nonce is greater than the highest nonce of pending relocations", async () => {
        await expect(multiTokenBridge.connect(relocator).cancelRelocations(
          chainId,
          [
            Math.max(...relocationNonces),
            Math.max(...relocationNonces) + 1
          ]
        )).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_NOT_EXISTENT);
      });

      it("Is reverted if a relocation with some nonce was already canceled", async () => {
        await cancelRelocations([relocations[1]]);
        await expect(
          multiTokenBridge.connect(relocator).cancelRelocations(chainId, relocationNonces)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_CANCELED);
      });

      it("Transfers the tokens as expected, emits the correct events, changes the state properly", async () => {
        await checkBridgeState(relocations);
        const relocationAccountAddresses: string[] =
          relocations.map((relocation: TestTokenRelocation) => relocation.account.address);
        const expectedAccountBalanceChangesForTokenMock1: number[] = getAmountByTokenAndAddresses(
          relocations,
          tokenMock1,
          relocationAccountAddresses
        );
        const expectedAccountBalanceChangesForTokenMock2: number[] = getAmountByTokenAndAddresses(
          relocations,
          tokenMock2,
          relocationAccountAddresses
        );
        const expectedBridgeBalanceChangeForTokenMock1 =
          countNumberArrayTotal(expectedAccountBalanceChangesForTokenMock1);
        const expectedBridgeBalanceChangeForTokenMock2 =
          countNumberArrayTotal(expectedAccountBalanceChangesForTokenMock2);

        await expect(
          multiTokenBridge.connect(relocator).cancelRelocations(chainId, relocationNonces)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, ...relocationAccountAddresses],
          [-expectedBridgeBalanceChangeForTokenMock1, ...expectedAccountBalanceChangesForTokenMock1]
        ).and.to.changeTokenBalances(
          tokenMock2,
          [multiTokenBridge, ...relocationAccountAddresses],
          [-expectedBridgeBalanceChangeForTokenMock2, ...expectedAccountBalanceChangesForTokenMock2]
        ).and.to.emit(
          multiTokenBridge,
          "CancelRelocation"
        ).withArgs(
          chainId,
          relocations[0].token.address,
          relocations[0].account.address,
          relocations[0].amount,
          relocations[0].nonce
        ).and.to.emit(
          multiTokenBridge,
          "CancelRelocation"
        ).withArgs(
          chainId,
          relocations[1].token.address,
          relocations[1].account.address,
          relocations[1].amount,
          relocations[1].nonce
        );
        relocations.forEach((relocation: TestTokenRelocation) => relocation.canceled = true);
        await checkBridgeState(relocations);
      });
    });

    describe("Function 'relocate()'", async () => {
      const relocationCount = 1;

      let relocation: TestTokenRelocation;
      let relocator: SignerWithAddress;

      beforeEach(async () => {
        relocation = {
          chainId: 345,
          token: tokenMock1,
          account: user1,
          amount: 678,
          nonce: 1,
        };
        relocator = user2;

        await setUpContractsForRelocations([relocation]);
        await requestRelocations([relocation]);
        await setBridgerRole(relocator);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseMultiTokenBridge();
        await expect(
          multiTokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await expect(
          multiTokenBridge.connect(deployer).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, bridgerRole));
      });

      it("Is reverted if the relocation count is zero", async () => {
        await expect(
          multiTokenBridge.connect(relocator).relocate(relocation.chainId, 0)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_COUNT_IS_ZERO);
      });

      it("Is reverted if the relocation count exceeds the number of pending relocations", async () => {
        await expect(
          multiTokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount + 1)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_LACK_OF_PENDING_RELOCATIONS);
      });

      it("Is reverted if burning of tokens had failed", async () => {
        await proveTx(tokenMock1.disableBurningForBridging());
        await expect(
          multiTokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED);
      });

      it("Burns no tokens, emits no events if the relocation was canceled", async () => {
        await cancelRelocations([relocation]);
        await checkBridgeState([relocation]);
        const balanceBefore: BigNumber = await tokenMock1.balanceOf(multiTokenBridge.address);
        await expect(
          multiTokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).and.not.to.emit(
          multiTokenBridge,
          "Relocate"
        );
        const balanceAfter: BigNumber = await tokenMock1.balanceOf(multiTokenBridge.address);
        expect(balanceAfter.sub(balanceBefore)).to.equal(0);
        markRelocationsAsProcessed([relocation]);
        await checkBridgeState([relocation]);
      });

      it("Burns tokens as expected, emits the correct event, changes the state properly", async () => {
        await expect(
          multiTokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, user1, user2],
          [-relocation.amount, 0, 0]
        ).and.to.emit(
          multiTokenBridge,
          "Relocate"
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          operationMode
        );
        markRelocationsAsProcessed([relocation]);
        await checkBridgeState([relocation]);
      });
    });

    describe("Complex scenario for a single chain with several tokens", async () => {
      const chainId = 123;

      let tokenMock2: Contract;
      let relocations: TestTokenRelocation[];
      let relocator: SignerWithAddress;

      beforeEach(async () => {
        tokenMock2 = await deployTokenMock(2);

        relocations = [
          {
            chainId: chainId,
            token: tokenMock1,
            account: user1,
            amount: 234,
            nonce: 1,
          },
          {
            chainId: chainId,
            token: tokenMock2,
            account: user1,
            amount: 345,
            nonce: 2,
          },
          {
            chainId: chainId,
            token: tokenMock2,
            account: user2,
            amount: 456,
            nonce: 3,
          },
          {
            chainId: chainId,
            token: tokenMock1,
            account: deployer,
            amount: 567,
            nonce: 4,
          },
        ];
        relocator = user2;
        await setUpContractsForRelocations(relocations);
        await setBridgerRole(relocator);
      });

      it("Executes as expected", async () => {
        // Request first 3 relocations
        await requestRelocations([relocations[0], relocations[1], relocations[2]]);
        await checkBridgeState(relocations);

        // Process the first relocation
        await proveTx(multiTokenBridge.connect(relocator).relocate(chainId, 1));
        markRelocationsAsProcessed([relocations[0]]);
        await checkBridgeState(relocations);

        // Try to cancel already processed relocation
        await expect(
          multiTokenBridge.connect(relocations[0].account).cancelRelocation(chainId, relocations[0].nonce)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED);

        // Try to cancel a relocation of another user
        await expect(
          multiTokenBridge.connect(relocations[1].account).cancelRelocation(chainId, relocations[2].nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_TX_SENDER_IS_UNAUTHORIZED_TO_CANCEL_RELOCATION
        );

        // Try to cancel several relocations including the processed one
        await expect(
          multiTokenBridge.connect(relocator).cancelRelocations(chainId, [
            relocations[2].nonce,
            relocations[1].nonce,
            relocations[0].nonce,
          ])
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED);

        // Try to cancel several relocations including one that is out of the pending range
        await expect(
          multiTokenBridge.connect(relocator).cancelRelocations(chainId, [
            relocations[3].nonce,
            relocations[2].nonce,
            relocations[1].nonce,
          ])
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_NOT_EXISTENT);

        // Check that state of the bridge has not changed
        await checkBridgeState(relocations);

        // Request another relocation
        await requestRelocations([relocations[3]]);
        await checkBridgeState(relocations);

        // Cancel two last relocations
        await proveTx(
          multiTokenBridge.connect(relocator).cancelRelocations(
            chainId,
            [relocations[3].nonce, relocations[2].nonce]
          )
        );
        [relocations[3], relocations[2]].forEach((relocation: TestTokenRelocation) => relocation.canceled = true);
        await checkBridgeState(relocations);

        // Process all the pending relocations
        await proveTx(multiTokenBridge.connect(relocator).relocate(chainId, 3));
        markRelocationsAsProcessed(relocations);
        await checkBridgeState(relocations);
      });
    });

    describe("Complex scenario for several chains with several tokens", async () => {
      const chainId1 = 123;
      const chainId2 = 234;

      let tokenMock2: Contract;
      let relocations: TestTokenRelocation[];
      let relocator: SignerWithAddress;
      let relocationCountForChain1: number;
      let relocationCountForChain2: number;

      beforeEach(async () => {
        tokenMock2 = await deployTokenMock(2);

        relocations = [
          {
            chainId: chainId1,
            token: tokenMock2,
            account: user1,
            amount: 345,
            nonce: 1,
          },
          {
            chainId: chainId1,
            token: tokenMock1,
            account: user1,
            amount: 456,
            nonce: 2,
          },
          {
            chainId: chainId2,
            token: tokenMock1,
            account: user2,
            amount: 567,
            nonce: 1,
          },
          {
            chainId: chainId2,
            token: tokenMock2,
            account: deployer,
            amount: 678,
            nonce: 2,
          },
        ];
        relocator = user2;
        relocationCountForChain1 = countRelocationsForChainId(relocations, chainId1);
        relocationCountForChain2 = countRelocationsForChainId(relocations, chainId2);
        await setUpContractsForRelocations(relocations);
        await setBridgerRole(relocator);
      });

      it("Executes as expected", async () => {
        // Request all relocations
        await requestRelocations(relocations);
        await checkBridgeState(relocations);

        // Cancel some relocations
        await cancelRelocations([relocations[1], relocations[2]]);
        await checkBridgeState(relocations);

        // Process all the pending relocations in all the chains
        await proveTx(multiTokenBridge.connect(relocator).relocate(chainId1, relocationCountForChain1));
        await proveTx(multiTokenBridge.connect(relocator).relocate(chainId2, relocationCountForChain2));
        markRelocationsAsProcessed(relocations);
        await checkBridgeState(relocations);
      });
    });
  });

  describe("Interactions related to relocations in the LockOrTransfer operation mode", async () => {
    let tokenMock: Contract;

    beforeEach(async () => {
      operationMode = OperationMode.LockOrTransfer;
      tokenMock = await deployTokenMock(1);
    });

    describe("Function 'requestRelocation()'", async () => {
      let relocation: TestTokenRelocation;

      beforeEach(async () => {
        relocation = {
          chainId: 123,
          token: tokenMock,
          account: user1,
          amount: 456,
          nonce: 1,
        };
        await setUpContractsForRelocations([relocation]);
      });

      it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
        await checkBridgeState([relocation]);
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            relocation.amount
          )
        ).to.changeTokenBalances(
          relocation.token,
          [multiTokenBridge, relocation.account],
          [+relocation.amount, -relocation.amount,]
        ).and.to.emit(
          multiTokenBridge,
          "RequestRelocation"
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce
        );
        relocation.requested = true;
        await checkBridgeState([relocation]);
      });
    });

    describe("Function 'relocate()'", async () => {
      const relocationCount = 1;

      let relocation: TestTokenRelocation;
      let relocator: SignerWithAddress;

      beforeEach(async () => {
        relocation = {
          chainId: 345,
          token: tokenMock,
          account: user1,
          amount: 678,
          nonce: 1,
        };
        relocator = user2;

        await setUpContractsForRelocations([relocation]);
        await requestRelocations([relocation]);
        await setBridgerRole(relocator);
      });

      it("Burns no tokens, emits the correct event, changes the state properly", async () => {
        await expect(
          multiTokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          relocation.token,
          [multiTokenBridge, relocation.account],
          [0, 0]
        ).and.to.emit(
          multiTokenBridge,
          "Relocate"
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          OperationMode.LockOrTransfer
        );
        markRelocationsAsProcessed([relocation]);
        await checkBridgeState([relocation]);
      });
    });
  });

  describe("Interactions related to accommodations in the BurnOrMint operation mode", async () => {

    describe("Function 'accommodate()'", async () => {
      const chainId = 123;
      const firstRelocationNonce = 1;

      let tokenMock1: Contract;
      let tokenMock2: Contract;
      let relocations: TestTokenRelocation[];
      let accommodator: SignerWithAddress;
      let onChainRelocations: OnChainRelocation[];

      beforeEach(async () => {
        operationMode = OperationMode.BurnOrMint;
        tokenMock1 = await deployTokenMock(1);
        tokenMock2 = await deployTokenMock(2);

        relocations = [
          {
            chainId: chainId,
            token: tokenMock1,
            account: user1,
            amount: 456,
            nonce: firstRelocationNonce,
            canceled: true,
          },
          {
            chainId: chainId,
            token: tokenMock1,
            account: user2,
            amount: 567,
            nonce: firstRelocationNonce + 1,
          },
          {
            chainId: chainId,
            token: tokenMock2,
            account: user2,
            amount: 678,
            nonce: firstRelocationNonce + 2,
          },
        ];
        accommodator = user2;
        onChainRelocations = relocations.map(toOnChainRelocation);

        await proveTx(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock1.address,
            operationMode
          )
        );
        await proveTx(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock2.address,
            operationMode
          )
        );
        await setBridgerRole(accommodator);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseMultiTokenBridge();
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await expect(
          multiTokenBridge.connect(deployer).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, bridgerRole));
      });

      it("Is reverted if the chain is unsupported for accommodations", async () => {
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId + 1,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED);
      });

      it("Is reverted if one of the token contracts is unsupported for accommodations", async () => {
        onChainRelocations[1].token = deployer.address;
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the first relocation nonce is zero", async () => {
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            0,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_NONCE_IS_ZERO);
      });

      it("Is reverted if the first relocation nonce does not equal the last accommodation nonce +1", async () => {
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce + 1,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH);
      });

      it("Is reverted if the input array of relocations is empty", async () => {
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            []
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_ARRAY_OF_RELOCATIONS_IS_EMPTY);
      });

      it("Is reverted if one of the input accounts has zero address", async () => {
        onChainRelocations[1].account = ethers.constants.AddressZero;
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS);
      });

      it("Is reverted if one of the input amounts is zero", async () => {
        onChainRelocations[1].amount = ethers.constants.Zero;
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO);
      });

      it("Is reverted if minting of tokens had failed", async () => {
        await proveTx(tokenMock1.disableMintingForBridging());
        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED);
      });

      it("Mints tokens as expected, emits the correct events, changes the state properly", async () => {
        const relocationAccountAddresses: string[] =
          relocations.map((relocation: TestTokenRelocation) => relocation.account.address);
        const relocationAccountAddressesWithoutDuplicates: string[] = [...new Set(relocationAccountAddresses)];
        const expectedBalanceChangesForTokenMock1: number[] = getAmountByTokenAndAddresses(
          relocations,
          tokenMock1,
          relocationAccountAddressesWithoutDuplicates
        );
        const expectedBalanceChangesForTokenMock2: number[] = getAmountByTokenAndAddresses(
          relocations,
          tokenMock2,
          relocationAccountAddressesWithoutDuplicates
        );

        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, ...relocationAccountAddressesWithoutDuplicates],
          [0, ...expectedBalanceChangesForTokenMock1]
        ).and.to.changeTokenBalances(
          tokenMock2,
          [multiTokenBridge, ...relocationAccountAddressesWithoutDuplicates],
          [0, ...expectedBalanceChangesForTokenMock2]
        ).and.to.emit(
          multiTokenBridge,
          "Accommodate"
        ).withArgs(
          chainId,
          relocations[1].token.address,
          relocations[1].account.address,
          relocations[1].amount,
          relocations[1].nonce,
          operationMode
        ).and.to.emit(
          multiTokenBridge,
          "Accommodate"
        ).withArgs(
          chainId,
          relocations[2].token.address,
          relocations[2].account.address,
          relocations[2].amount,
          relocations[2].nonce,
          operationMode
        );
        expect(
          await multiTokenBridge.getLastAccommodationNonce(chainId)
        ).to.equal(relocations[relocations.length - 1].nonce);
      });
    });
  });

  describe("Interactions related to accommodations in the LockOrTransfer operation mode", async () => {

    describe("Function 'accommodate()'", async () => {
      const chainId = 123;
      const firstRelocationNonce = 1;

      let tokenMock1: Contract;
      let tokenMock2: Contract;
      let relocations: TestTokenRelocation[];
      let accommodator: SignerWithAddress;
      let onChainRelocations: OnChainRelocation[];

      beforeEach(async () => {
        operationMode = OperationMode.LockOrTransfer;
        tokenMock1 = await deployTokenMock(1);
        tokenMock2 = await deployTokenMock(2);

        relocations = [
          {
            chainId: chainId,
            token: tokenMock1,
            account: user1,
            amount: 456,
            nonce: firstRelocationNonce,
            canceled: true,
          },
          {
            chainId: chainId,
            token: tokenMock1,
            account: user2,
            amount: 567,
            nonce: firstRelocationNonce + 1,
          },
          {
            chainId: chainId,
            token: tokenMock2,
            account: user2,
            amount: 678,
            nonce: firstRelocationNonce + 2,
          },
        ];
        accommodator = user2;
        onChainRelocations = relocations.map(toOnChainRelocation);

        await proveTx(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock1.address,
            operationMode
          )
        );
        await proveTx(
          multiTokenBridge.setAccommodationMode(
            chainId,
            tokenMock2.address,
            operationMode
          )
        );
        await setBridgerRole(accommodator);
      });

      it("Transfers tokens as expected, emits the correct events, changes the state properly", async () => {
        const relocationAccountAddresses: string[] =
          relocations.map((relocation: TestTokenRelocation) => relocation.account.address);
        const relocationAccountAddressesWithoutDuplicates: string[] = [...new Set(relocationAccountAddresses)];
        const expectedBalanceChangesForTokenMock1: number[] = getAmountByTokenAndAddresses(
          relocations,
          tokenMock1,
          relocationAccountAddressesWithoutDuplicates
        );
        const expectedBridgeBalanceChangeForTokenMock1: number =
          countNumberArrayTotal(expectedBalanceChangesForTokenMock1);
        const expectedBalanceChangesForTokenMock2: number[] = getAmountByTokenAndAddresses(
          relocations,
          tokenMock2,
          relocationAccountAddressesWithoutDuplicates
        );
        const expectedBridgeBalanceChangeForTokenMock2: number =
          countNumberArrayTotal(expectedBalanceChangesForTokenMock2);

        await proveTx(tokenMock1.mint(multiTokenBridge.address, expectedBridgeBalanceChangeForTokenMock1));
        await proveTx(tokenMock2.mint(multiTokenBridge.address, expectedBridgeBalanceChangeForTokenMock2));

        await expect(
          multiTokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, ...relocationAccountAddressesWithoutDuplicates],
          [-expectedBridgeBalanceChangeForTokenMock1, ...expectedBalanceChangesForTokenMock1]
        ).and.to.changeTokenBalances(
          tokenMock2,
          [multiTokenBridge, ...relocationAccountAddressesWithoutDuplicates],
          [-expectedBridgeBalanceChangeForTokenMock2, ...expectedBalanceChangesForTokenMock2]
        ).and.to.emit(
          multiTokenBridge,
          "Accommodate"
        ).withArgs(
          chainId,
          relocations[1].token.address,
          relocations[1].account.address,
          relocations[1].amount,
          relocations[1].nonce,
          operationMode
        ).and.to.emit(
          multiTokenBridge,
          "Accommodate"
        ).withArgs(
          chainId,
          relocations[2].token.address,
          relocations[2].account.address,
          relocations[2].amount,
          relocations[2].nonce,
          operationMode
        );
        expect(
          await multiTokenBridge.getLastAccommodationNonce(chainId)
        ).to.equal(relocations[relocations.length - 1].nonce);
      });
    });
  });
});
