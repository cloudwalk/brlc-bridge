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
  account: SignerWithAddress;
  amount: number;
  nonce: number;
  requested?: boolean;
  processed?: boolean;
  canceled?: boolean;
}


interface OnChainRelocation {
  account: string;
  amount: BigNumber;
  canceled: boolean;
}

const defaultOnChainRelocation: OnChainRelocation = {
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

describe("Contract 'TokenBridge'", async () => {
  // Revert messages
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_TOKEN_DOES_NOT_SUPPORT_BRIDGE_OPERATIONS = "NonBridgeableToken";
  const REVERT_ERROR_IF_RELOCATION_AMOUNT_IS_ZERO = "ZeroRelocationAmount";
  const REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED = "UnsupportedRelocation";
  const REVERT_ERROR_IF_UNSUPPORTING_TOKEN = "UnsupportingToken";
  const REVERT_ERROR_IF_TRANSACTION_SENDER_IS_UNAUTHORIZED = "UnauthorizedTransactionSender";
  const REVERT_ERROR_IF_RELOCATION_ARRAY_OF_NONCES_IS_EMPTY = "EmptyNonceArray";
  const REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED = "AlreadyProcessedRelocation";
  const REVERT_ERROR_IF_RELOCATION_DOES_NOT_EXIST = "NotExistentRelocation";
  const REVERT_ERROR_IF_RELOCATION_IS_ALREADY_CANCELED = "AlreadyCanceledRelocation";
  const REVERT_ERROR_IF_RELOCATION_COUNT_IS_ZERO = "ZeroRelocationCount";
  const REVERT_ERROR_IF_THERE_IS_LACK_PENDING_RELOCATIONS = "LackOfPendingRelocations";
  const REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED = "TokenBurningFailure";
  const REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED = "UnsupportedAccommodation";
  const REVERT_ERROR_IF_ACCOMMODATION_FIRST_NONCE_IS_ZERO = "ZeroAccommodationNonce";
  const REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH = "AccommodationNonceMismatch";
  const REVERT_ERROR_IF_INPUT_ARRAY_OF_RELOCATIONS_IS_EMPTY = "EmptyRelocationArray";
  const REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS = "ZeroAccommodationAccount";
  const REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO = "ZeroAccommodationAmount";
  const REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED = "TokenMintingFailure";

  let TokenBridge: ContractFactory;
  let tokenBridge: Contract;
  let tokenMock: Contract;
  let deployer: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let ownerRole: string;
  let pauserRole: string;
  let rescuerRole: string;
  let bridgerRole: string;
  let operationMode: OperationMode;

  async function setUpContractsForRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      const relocationMode: OperationMode = await tokenBridge.getRelocationMode(relocation.chainId);
      if (relocationMode !== operationMode) {
        await proveTx(tokenBridge.setRelocationMode(relocation.chainId, operationMode));
      }
      await proveTx(tokenMock.mint(relocation.account.address, relocation.amount));
      const allowance: BigNumber =
        await tokenMock.allowance(relocation.account.address, tokenBridge.address);
      if (allowance.lt(BigNumber.from(ethers.constants.MaxUint256))) {
        await proveTx(
          tokenMock.connect(relocation.account).approve(
            tokenBridge.address,
            ethers.constants.MaxUint256
          )
        );
      }
    }
  }

  async function requestRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        tokenBridge.connect(relocation.account).requestRelocation(relocation.chainId, relocation.amount)
      );
      relocation.requested = true;
    }
  }

  async function pauseTokenBridge() {
    await proveTx(tokenBridge.grantRole(pauserRole, deployer.address));
    await proveTx(tokenBridge.pause());
  }

  async function setBridgerRole(account: SignerWithAddress) {
    await proveTx(tokenBridge.grantRole(bridgerRole, account.address));
  }

  async function cancelRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        tokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce)
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
    const expectedStatesPerChainId: Map<number, BridgeStateForChainId> = new Map<number, BridgeStateForChainId>();

    expectedChainIds.forEach((chainId: number) => {
      const expectedBridgeState: BridgeStateForChainId =
        defineExpectedBridgeStateForSingleChainId(chainId, relocations);
      expectedStatesPerChainId.set(chainId, expectedBridgeState);
    });

    return expectedStatesPerChainId;
  }

  function defineExpectedBridgeBalance(relocations: TestTokenRelocation[]): number {
    return countNumberArrayTotal(
      relocations.map(function (relocation: TestTokenRelocation): number {
          if (
            !!relocation.requested
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
  }

  async function checkBridgeStatesPerChainId(expectedBridgeStatesPerChainId: Map<number, BridgeStateForChainId>) {
    for (const expectedChainId of expectedBridgeStatesPerChainId.keys()) {
      const expectedBridgeState: BridgeStateForChainId | undefined =
        expectedBridgeStatesPerChainId.get(expectedChainId);
      if (!expectedBridgeState) {
        continue;
      }
      expect(
        await tokenBridge.getPendingRelocationCounter(expectedChainId)
      ).to.equal(
        expectedBridgeState.pendingRelocationCount,
        `Wrong pending relocation count, chainId=${expectedChainId}`
      );
      expect(
        await tokenBridge.getLastProcessedRelocationNonce(expectedChainId)
      ).to.equal(
        expectedBridgeState.processedRelocationCount,
        `Wrong requested relocation count, chainId=${expectedChainId}`
      );
      const actualRelocations = await tokenBridge.getRelocations(
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
        const actualRelocation = await tokenBridge.getRelocation(relocation.chainId, relocation.nonce);
        checkEquality(actualRelocation, toOnChainRelocation(relocation), i, relocation.chainId);
      }
    }
  }

  async function checkBridgeState(relocations: TestTokenRelocation[]): Promise<void> {
    const expectedBridgeStatesPerChainId: Map<number, BridgeStateForChainId> =
      defineExpectedBridgeStatesPerChainId(relocations);
    const expectedBridgeBalance: number = defineExpectedBridgeBalance(relocations);

    await checkBridgeStatesPerChainId(expectedBridgeStatesPerChainId);
    await checkRelocationStructures(relocations);
    expect(await tokenMock.balanceOf(tokenBridge.address)).to.equal(expectedBridgeBalance);
  }

  beforeEach(async () => {
    // Deploy BRLC
    const TokenMock: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    tokenMock = await TokenMock.deploy();
    await tokenMock.deployed();
    await proveTx(tokenMock.initialize("BRL Coin", "BRLC"));

    // Deploy TokenBridge
    TokenBridge = await ethers.getContractFactory("TokenBridge");
    tokenBridge = await TokenBridge.deploy();
    await tokenBridge.deployed();
    await proveTx(tokenBridge.initialize(tokenMock.address));

    // Get user accounts
    [deployer, user1, user2] = await ethers.getSigners();

    // Roles
    ownerRole = (await tokenBridge.OWNER_ROLE()).toLowerCase();
    pauserRole = (await tokenBridge.PAUSER_ROLE()).toLowerCase();
    rescuerRole = (await tokenBridge.RESCUER_ROLE()).toLowerCase();
    bridgerRole = (await tokenBridge.BRIDGER_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(
      tokenBridge.initialize(tokenMock.address)
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The underlying contract address
    expect(await tokenBridge.underlyingToken()).to.equal(tokenMock.address);

    // The role admins
    expect(await tokenBridge.getRoleAdmin(ownerRole)).to.equal(ownerRole);
    expect(await tokenBridge.getRoleAdmin(pauserRole)).to.equal(ownerRole);
    expect(await tokenBridge.getRoleAdmin(rescuerRole)).to.equal(ownerRole);
    expect(await tokenBridge.getRoleAdmin(bridgerRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await tokenBridge.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await tokenBridge.hasRole(pauserRole, deployer.address)).to.equal(false);
    expect(await tokenBridge.hasRole(rescuerRole, deployer.address)).to.equal(false);
    expect(await tokenBridge.hasRole(bridgerRole, deployer.address)).to.equal(false);

    // The initial contract state is unpaused
    expect(await tokenBridge.paused()).to.equal(false);
  });

  describe("Configuration", async () => {
    describe("Function 'setRelocationMode()'", async () => {
      const chainId = 123;

      it("Is reverted if is called not by the account with the owner role", async () => {
        await expect(
          tokenBridge.connect(user1).setRelocationMode(chainId, OperationMode.BurnOrMint)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        const otherTokenBridge: Contract = await TokenBridge.deploy();
        await otherTokenBridge.deployed();
        const fakeTokenAddress: string = deployer.address;
        await proveTx(otherTokenBridge.initialize(fakeTokenAddress));
        await expect(
          otherTokenBridge.setRelocationMode(
            chainId,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_TOKEN_DOES_NOT_SUPPORT_BRIDGE_OPERATIONS);
      });

      it("Emits the correct events and updates the configuration correctly", async () => {
        const relocationModeOld: OperationMode = await tokenBridge.getRelocationMode(chainId);
        expect(relocationModeOld).to.equal(OperationMode.Unsupported);
        await expect(
          tokenBridge.setRelocationMode(chainId, OperationMode.BurnOrMint)
        ).to.emit(
          tokenBridge,
          "SetRelocationMode"
        ).withArgs(
          chainId,
          OperationMode.Unsupported,
          OperationMode.BurnOrMint
        );
        const relocationModeNew: OperationMode = await tokenBridge.getRelocationMode(chainId);
        expect(relocationModeNew).to.equal(OperationMode.BurnOrMint);

        // Second call with the same argument should not emit an event
        await expect(
          tokenBridge.setRelocationMode(chainId, OperationMode.BurnOrMint)
        ).not.to.emit(tokenBridge, "SetRelocationMode");

        await expect(
          tokenBridge.setRelocationMode(chainId, OperationMode.LockOrTransfer)
        ).to.emit(
          tokenBridge,
          "SetRelocationMode"
        ).withArgs(
          chainId,
          OperationMode.BurnOrMint,
          OperationMode.LockOrTransfer
        );
        const relocationModeNew2: OperationMode = await tokenBridge.getRelocationMode(chainId);
        expect(relocationModeNew2).to.equal(OperationMode.LockOrTransfer);

        await expect(
          tokenBridge.setRelocationMode(chainId, OperationMode.Unsupported)
        ).to.emit(
          tokenBridge,
          "SetRelocationMode"
        ).withArgs(
          chainId,
          OperationMode.LockOrTransfer,
          OperationMode.Unsupported
        );
        const relocationModeNew3: OperationMode = await tokenBridge.getRelocationMode(chainId);
        expect(relocationModeNew3).to.equal(OperationMode.Unsupported);
      });
    });

    describe("Function 'setAccommodationMode()'", async () => {
      const chainId = 123;

      it("Is reverted if is called not by the account with the owner role", async () => {
        await expect(
          tokenBridge.connect(user1).setAccommodationMode(chainId, OperationMode.BurnOrMint)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        const otherTokenBridge: Contract = await TokenBridge.deploy();
        await otherTokenBridge.deployed();
        const fakeTokenAddress: string = deployer.address;
        await proveTx(otherTokenBridge.initialize(fakeTokenAddress));
        await expect(
          otherTokenBridge.setAccommodationMode(chainId, OperationMode.BurnOrMint)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_TOKEN_DOES_NOT_SUPPORT_BRIDGE_OPERATIONS);
      });

      it("Emits the correct events and updates the configuration correctly", async () => {
        const accommodationModeOld: OperationMode = await tokenBridge.getAccommodationMode(chainId);
        expect(accommodationModeOld).to.equal(OperationMode.Unsupported);
        await expect(
          tokenBridge.setAccommodationMode(chainId, OperationMode.BurnOrMint)
        ).to.emit(
          tokenBridge,
          "SetAccommodationMode"
        ).withArgs(
          chainId,
          OperationMode.Unsupported,
          OperationMode.BurnOrMint
        );
        const accommodationModeNew: OperationMode = await tokenBridge.getAccommodationMode(chainId);
        expect(accommodationModeNew).to.equal(OperationMode.BurnOrMint);

        // Second call with the same argument should not emit an event
        await expect(
          tokenBridge.setAccommodationMode(chainId, OperationMode.BurnOrMint)
        ).not.to.emit(tokenBridge, "SetAccommodationMode");

        await expect(
          tokenBridge.setAccommodationMode(chainId, OperationMode.LockOrTransfer)
        ).to.emit(
          tokenBridge,
          "SetAccommodationMode"
        ).withArgs(
          chainId,
          OperationMode.BurnOrMint,
          OperationMode.LockOrTransfer
        );
        const accommodationModeNew2: OperationMode = await tokenBridge.getAccommodationMode(chainId);
        expect(accommodationModeNew2).to.equal(OperationMode.LockOrTransfer);

        await expect(
          tokenBridge.setAccommodationMode(chainId, OperationMode.Unsupported)
        ).to.emit(
          tokenBridge,
          "SetAccommodationMode"
        ).withArgs(
          chainId,
          OperationMode.LockOrTransfer,
          OperationMode.Unsupported
        );
        const accommodationModeNew3: OperationMode = await tokenBridge.getAccommodationMode(chainId);
        expect(accommodationModeNew3).to.equal(OperationMode.Unsupported);
      });
    });
  });

  describe("Interactions related to relocations in the BurnOrMint operation mode", async () => {

    beforeEach(async () => {
      operationMode = OperationMode.BurnOrMint;
      await proveTx(tokenMock.setBridge(tokenBridge.address));
    });

    describe("Function 'requestRelocation()'", async () => {
      let relocation: TestTokenRelocation;

      beforeEach(async () => {
        relocation = {
          chainId: 123,
          account: user1,
          amount: 456,
          nonce: 1,
        };
        await setUpContractsForRelocations([relocation]);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseTokenBridge();
        await expect(
          tokenBridge.connect(relocation.account).requestRelocation(relocation.chainId, relocation.amount)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the token amount of the relocation is zero", async () => {
        await expect(
          tokenBridge.connect(relocation.account).requestRelocation(relocation.chainId, 0)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_AMOUNT_IS_ZERO);
      });

      it("Is reverted if the relocation to the target chain is unsupported", async () => {
        await expect(
          tokenBridge.connect(relocation.account).requestRelocation(relocation.chainId + 1, relocation.amount)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the token does not support the bridge", async () => {
        await proveTx(tokenMock.setBridge(deployer.address));
        await expect(
          tokenBridge.connect(relocation.account).requestRelocation(relocation.chainId, relocation.amount)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_UNSUPPORTING_TOKEN);
      });

      it("Is reverted if the user has not enough token balance", async () => {
        const excessTokenAmount: number = relocation.amount + 1;
        await expect(
          tokenBridge.connect(relocation.account).requestRelocation(relocation.chainId, excessTokenAmount)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
        await checkBridgeState([relocation]);
        await expect(
          tokenBridge.connect(relocation.account).requestRelocation(relocation.chainId, relocation.amount)
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, relocation.account],
          [+relocation.amount, -relocation.amount]
        ).and.to.emit(
          tokenBridge,
          "RequestRelocation"
        ).withArgs(
          relocation.chainId,
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
          account: user1,
          amount: 567,
          nonce: 1,
        };
        await setUpContractsForRelocations([relocation]);
        await requestRelocations([relocation]);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseTokenBridge();
        await expect(
          tokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller did not request the relocation", async () => {
        await expect(
          tokenBridge.connect(user2).cancelRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_TRANSACTION_SENDER_IS_UNAUTHORIZED);
      });

      it("Is reverted if a relocation with the nonce has already processed", async () => {
        await expect(
          tokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce - 1)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_TRANSACTION_SENDER_IS_UNAUTHORIZED);
      });

      it("Is reverted if a relocation with the nonce does not exists", async () => {
        await expect(
          tokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce + 1)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_TRANSACTION_SENDER_IS_UNAUTHORIZED);
      });

      it("Transfers the tokens as expected, emits the correct event, changes the state properly", async () => {
        await checkBridgeState([relocation]);
        await expect(
          tokenBridge.connect(relocation.account).cancelRelocation(relocation.chainId, relocation.nonce)
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, relocation.account],
          [-relocation.amount, +relocation.amount]
        ).and.to.emit(
          tokenBridge,
          "CancelRelocation"
        ).withArgs(
          relocation.chainId,
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

      let relocations: TestTokenRelocation[];
      let relocator: SignerWithAddress;
      let relocationNonces: number[];

      beforeEach(async () => {
        relocations = [
          {
            chainId: chainId,
            account: user1,
            amount: 34,
            nonce: 1,
          },
          {
            chainId: chainId,
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
        await pauseTokenBridge();
        await expect(
          tokenBridge.connect(relocator).cancelRelocations(chainId, relocationNonces)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await expect(
          tokenBridge.connect(deployer).cancelRelocations(chainId, relocationNonces)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, bridgerRole));
      });

      it("Is reverted if the input array of nonces is empty", async () => {
        await expect(
          tokenBridge.connect(relocator).cancelRelocations(chainId, [])
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_ARRAY_OF_NONCES_IS_EMPTY);
      });

      it("Is reverted if some input nonce is less than the lowest nonce of pending relocations", async () => {
        await expect(
          tokenBridge.connect(relocator).cancelRelocations(
            chainId,
            [
              Math.min(...relocationNonces),
              Math.min(...relocationNonces) - 1,
            ]
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED);
      });

      it("Is reverted if some input nonce is greater than the highest nonce of pending relocations", async () => {
        await expect(
          tokenBridge.connect(relocator).cancelRelocations(
            chainId,
            [
              Math.max(...relocationNonces),
              Math.max(...relocationNonces) + 1
            ]
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_DOES_NOT_EXIST);
      });

      it("Is reverted if a relocation with some nonce is already canceled", async () => {
        await cancelRelocations([relocations[1]]);
        await expect(
          tokenBridge.connect(relocator).cancelRelocations(chainId, relocationNonces)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_CANCELED);
      });

      it("Transfers the tokens as expected, emits the correct events, changes the state properly", async () => {
        await checkBridgeState(relocations);

        const relocationAmounts: number[] = relocations.map((relocation: TestTokenRelocation) => relocation.amount);
        const relocationAccounts: SignerWithAddress[] =
          relocations.map((relocation: TestTokenRelocation) => relocation.account);
        const relocationAmountTotal: number = countNumberArrayTotal(relocationAmounts);

        await expect(
          tokenBridge.connect(relocator).cancelRelocations(chainId, relocationNonces)
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, ...relocationAccounts],
          [-(relocationAmountTotal), ...relocationAmounts]
        ).and.to.emit(
          tokenBridge,
          "CancelRelocation"
        ).withArgs(
          chainId,
          relocations[0].account.address,
          relocations[0].amount,
          relocations[0].nonce
        ).and.to.emit(
          tokenBridge,
          "CancelRelocation"
        ).withArgs(
          chainId,
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
        await pauseTokenBridge();
        await expect(
          tokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await expect(
          tokenBridge.connect(deployer).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, bridgerRole));
      });

      it("Is reverted if the relocation count is zero", async () => {
        await expect(
          tokenBridge.connect(relocator).relocate(relocation.chainId, 0)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_COUNT_IS_ZERO);
      });

      it("Is reverted if the relocation count exceeds the number of pending relocations", async () => {
        await expect(
          tokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount + 1)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_THERE_IS_LACK_PENDING_RELOCATIONS);
      });

      it("Is reverted if the token does not support the bridge", async () => {
        await proveTx(tokenMock.setBridge(deployer.address));
        await expect(
          tokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_UNSUPPORTING_TOKEN);
      });

      it("Is reverted if burning of tokens had failed", async () => {
        await proveTx(tokenMock.disableBurningForBridging());
        await expect(
          tokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED);
      });

      it("Burns no tokens, emits no events if the relocation was canceled", async () => {
        await cancelRelocations([relocation]);
        await checkBridgeState([relocation]);
        const balanceBefore: BigNumber = await tokenMock.balanceOf(tokenBridge.address);
        await expect(
          tokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).and.not.to.emit(
          tokenBridge,
          "Relocate"
        );
        const balanceAfter: BigNumber = await tokenMock.balanceOf(tokenBridge.address);
        expect(balanceAfter.sub(balanceBefore)).to.equal(0);
        markRelocationsAsProcessed([relocation]);
        await checkBridgeState([relocation]);
      });

      it("Burns tokens as expected, emits the correct event, changes the state properly", async () => {
        await expect(
          tokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, user1, user2],
          [-relocation.amount, 0, 0]
        ).and.to.emit(
          tokenBridge,
          "Relocate"
        ).withArgs(
          relocation.chainId,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          operationMode
        );
        markRelocationsAsProcessed([relocation]);
        await checkBridgeState([relocation]);
      });
    });

    describe("Complex scenario for a single chain", async () => {
      const chainId = 123;

      let relocations: TestTokenRelocation[];
      let relocator: SignerWithAddress;

      beforeEach(async () => {
        relocations = [
          {
            chainId: chainId,
            account: user1,
            amount: 234,
            nonce: 1,
          },
          {
            chainId: chainId,
            account: user1,
            amount: 345,
            nonce: 2,
          },
          {
            chainId: chainId,
            account: user2,
            amount: 456,
            nonce: 3,
          },
          {
            chainId: chainId,
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
        await proveTx(tokenBridge.connect(relocator).relocate(chainId, 1));
        markRelocationsAsProcessed([relocations[0]]);
        await checkBridgeState(relocations);

        // Try to cancel already processed relocation
        await expect(
          tokenBridge.connect(relocations[0].account).cancelRelocation(chainId, relocations[0].nonce)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED);

        // Try to cancel a relocation of another user
        await expect(
          tokenBridge.connect(relocations[1].account).cancelRelocation(chainId, relocations[2].nonce)
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_TRANSACTION_SENDER_IS_UNAUTHORIZED);

        // Try to cancel several relocations including the processed one
        await expect(
          tokenBridge.connect(relocator).cancelRelocations(chainId, [
            relocations[2].nonce,
            relocations[1].nonce,
            relocations[0].nonce,
          ])
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_IS_ALREADY_PROCESSED);

        // Try to cancel several relocations including one that is out of the pending range
        await expect(
          tokenBridge.connect(relocator).cancelRelocations(chainId, [
            relocations[3].nonce,
            relocations[2].nonce,
            relocations[1].nonce,
          ])
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_RELOCATION_DOES_NOT_EXIST);

        // Check that state of the bridge has not changed
        await checkBridgeState(relocations);

        // Request another relocation
        await requestRelocations([relocations[3]]);
        await checkBridgeState(relocations);

        // Cancel two last relocations
        await proveTx(
          tokenBridge.connect(relocator).cancelRelocations(
            chainId,
            [relocations[3].nonce, relocations[2].nonce]
          )
        );
        [relocations[3], relocations[2]].forEach((relocation: TestTokenRelocation) => relocation.canceled = true);
        await checkBridgeState(relocations);

        // Process all the pending relocations
        await proveTx(tokenBridge.connect(relocator).relocate(chainId, 3));
        markRelocationsAsProcessed(relocations);
        await checkBridgeState(relocations);
      });
    });

    describe("Complex scenario for several chains", async () => {
      const chainId1 = 123;
      const chainId2 = 234;

      let relocations: TestTokenRelocation[];
      let relocator: SignerWithAddress;
      let relocationCountForChain1: number;
      let relocationCountForChain2: number;

      beforeEach(async () => {
        relocations = [
          {
            chainId: chainId1,
            account: user1,
            amount: 345,
            nonce: 1,
          },
          {
            chainId: chainId1,
            account: user1,
            amount: 456,
            nonce: 2,
          },
          {
            chainId: chainId2,
            account: user2,
            amount: 567,
            nonce: 1,
          },
          {
            chainId: chainId2,
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
        await proveTx(tokenBridge.connect(relocator).relocate(chainId1, relocationCountForChain1));
        await proveTx(tokenBridge.connect(relocator).relocate(chainId2, relocationCountForChain2));
        markRelocationsAsProcessed(relocations);
        await checkBridgeState(relocations);
      });
    });
  });

  describe("Interactions related to relocations in the LockOrTransfer operation mode", async () => {

    beforeEach(async () => {
      operationMode = OperationMode.LockOrTransfer;
    });

    describe("Function 'requestRelocation()'", async () => {
      let relocation: TestTokenRelocation;

      beforeEach(async () => {
        relocation = {
          chainId: 123,
          account: user1,
          amount: 456,
          nonce: 1,
        };
        await setUpContractsForRelocations([relocation]);
      });

      it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
        await checkBridgeState([relocation]);
        await expect(
          tokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.amount
          )
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, relocation.account],
          [+relocation.amount, -relocation.amount,]
        ).and.to.emit(
          tokenBridge,
          "RequestRelocation"
        ).withArgs(
          relocation.chainId,
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
          tokenBridge.connect(relocator).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, relocation.account],
          [0, 0]
        ).and.to.emit(
          tokenBridge,
          "Relocate"
        ).withArgs(
          relocation.chainId,
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

      let relocations: TestTokenRelocation[];
      let accommodator: SignerWithAddress;
      let onChainRelocations: OnChainRelocation[];

      beforeEach(async () => {
        operationMode = OperationMode.BurnOrMint;
        await proveTx(tokenMock.setBridge(tokenBridge.address));
        relocations = [
          {
            chainId: chainId,
            account: user1,
            amount: 456,
            nonce: firstRelocationNonce,
            canceled: true,
          },
          {
            chainId: chainId,
            account: user2,
            amount: 789,
            nonce: firstRelocationNonce + 1,
          },
        ];
        accommodator = user2;
        onChainRelocations = relocations.map(toOnChainRelocation);

        await proveTx(tokenBridge.setAccommodationMode(chainId, operationMode));
        await setBridgerRole(accommodator);
      });

      it("Is reverted if the contract is paused", async () => {
        await pauseTokenBridge();
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await expect(
          tokenBridge.connect(deployer).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, bridgerRole));
      });

      it("Is reverted if the accommodation from the target chain is unsupported", async () => {
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId + 1,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the first relocation nonce is zero", async () => {
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            0,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_ACCOMMODATION_FIRST_NONCE_IS_ZERO);
      });

      it("Is reverted if the first relocation nonce does not equal the last accommodation nonce +1", async () => {
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce + 1,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH);
      });

      it("Is reverted if the input array of relocations is empty", async () => {
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            []
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_INPUT_ARRAY_OF_RELOCATIONS_IS_EMPTY);
      });

      it("Is reverted if the token does not support the bridge", async () => {
        await proveTx(tokenMock.setBridge(deployer.address));
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_UNSUPPORTING_TOKEN);
      });

      it("Is reverted if one of the input accounts has zero address", async () => {
        onChainRelocations[1].account = ethers.constants.AddressZero;
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS);
      });

      it("Is reverted if one of the input amounts is zero", async () => {
        onChainRelocations[1].amount = ethers.constants.Zero;
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO);
      });

      it("Is reverted if minting of tokens had failed", async () => {
        await proveTx(tokenMock.disableMintingForBridging());
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(tokenBridge, REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED);
      });

      it("Mints tokens as expected, emits the correct events, changes the state properly", async () => {
        const relocationAccountAddresses: string[] =
          relocations.map((relocation: TestTokenRelocation) => relocation.account.address);
        const expectedMintingAmounts: number[] =
          relocations.map((relocation: TestTokenRelocation) => !!relocation.canceled ? 0 : relocation.amount);
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, ...relocationAccountAddresses],
          [0, ...expectedMintingAmounts]
        ).and.to.emit(
          tokenBridge,
          "Accommodate"
        ).withArgs(
          chainId,
          relocations[1].account.address,
          relocations[1].amount,
          relocations[1].nonce,
          operationMode
        );
        expect(
          await tokenBridge.getLastAccommodationNonce(chainId)
        ).to.equal(relocations[relocations.length - 1].nonce);
      });
    });
  });

  describe("Interactions related to accommodations in the LockOrTransfer operation mode", async () => {

    describe("Function 'accommodate()'", async () => {
      const chainId = 123;
      const firstRelocationNonce = 1;

      let relocations: TestTokenRelocation[];
      let accommodator: SignerWithAddress;
      let onChainRelocations: OnChainRelocation[];

      beforeEach(async () => {
        operationMode = OperationMode.LockOrTransfer;
        relocations = [
          {
            chainId: chainId,
            account: user1,
            amount: 456,
            nonce: firstRelocationNonce,
            canceled: true,
          },
          {
            chainId: chainId,
            account: user2,
            amount: 789,
            nonce: firstRelocationNonce + 1,
          },
        ];
        accommodator = user2;
        onChainRelocations = relocations.map(toOnChainRelocation);

        await proveTx(tokenBridge.setAccommodationMode(chainId, operationMode));
        await setBridgerRole(accommodator);
      });

      it("Transfers tokens as expected, emits the correct events, changes the state properly", async () => {
        const relocationAccountAddresses: string[] =
          relocations.map((relocation: TestTokenRelocation) => relocation.account.address);
        const expectedTransferAmounts: number[] =
          relocations.map((relocation: TestTokenRelocation) => !!relocation.canceled ? 0 : relocation.amount);
        const expectedBridgeBalanceChange: number = countNumberArrayTotal(expectedTransferAmounts);
        await proveTx(tokenMock.mint(tokenBridge.address, expectedBridgeBalanceChange));
        await expect(
          tokenBridge.connect(accommodator).accommodate(
            chainId,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.changeTokenBalances(
          tokenMock,
          [tokenBridge, ...relocationAccountAddresses],
          [-expectedBridgeBalanceChange, ...expectedTransferAmounts]
        ).and.to.emit(
          tokenBridge,
          "Accommodate"
        ).withArgs(
          chainId,
          relocations[1].account.address,
          relocations[1].amount,
          relocations[1].nonce,
          operationMode
        );
        expect(
          await tokenBridge.getLastAccommodationNonce(chainId)
        ).to.equal(relocations[relocations.length - 1].nonce);
      });
    });
  });
});
