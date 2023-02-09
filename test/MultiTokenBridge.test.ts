import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { TransactionResponse } from "@ethersproject/abstract-provider";

enum OperationMode {
  Unsupported = 0,
  BurnOrMint = 1,
  LockOrTransfer = 2,
}

enum RelocationStatus {
  Nonexistent = 0,
  Pending = 1,
  Canceled = 2,
  Processed = 3,
  Revoked = 4,
  Aborted = 5,
}

interface TestTokenRelocation {
  chainId: number;
  token: Contract;
  account: SignerWithAddress;
  amount: number;
  nonce: number;
  requested?: boolean;
  processed?: boolean;
  status?: RelocationStatus;
}

interface OnChainRelocation {
  token: string;
  account: string;
  amount: BigNumber;
  status: RelocationStatus;
}

const defaultOnChainRelocation: OnChainRelocation = {
  token: ethers.constants.AddressZero,
  account: ethers.constants.AddressZero,
  amount: ethers.constants.Zero,
  status: RelocationStatus.Nonexistent
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
    status: relocation.status || RelocationStatus.Nonexistent,
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
  expect(actualOnChainRelocation.status).to.equal(
    expectedRelocation.status,
    `relocation[${relocationIndex}].status is incorrect, chainId=${chainId}`
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
  relocations.forEach((relocation: TestTokenRelocation) => {
    relocation.processed = true;
    if (relocation.status === RelocationStatus.Pending) {
      relocation.status = RelocationStatus.Processed;
    }
  });
}

function getAmountByTokenAndAddresses(
  relocations: TestTokenRelocation[],
  targetToken: Contract,
  addresses: string[],
  targetStatus: RelocationStatus
): number[] {
  const totalAmountPerAddress: Map<string, number> = new Map<string, number>();
  relocations.forEach(relocation => {
    const address = relocation.account.address;
    let totalAmount = totalAmountPerAddress.get(address) || 0;
    if (relocation.token == targetToken && relocation.status === targetStatus) {
      totalAmount += relocation.amount;
    }
    totalAmountPerAddress.set(address, totalAmount);
  });
  return addresses.map((address: string) => totalAmountPerAddress.get(address) || 0);
}

async function setUpFixture(func: any) {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'MultiTokenBridge'", async () => {
  const MINIMUM_RELOCATION_AMOUNT = 50;
  const FAKE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000001";
  const CHAIN_ID = 123;

  const EVENT_NAME_ACCOMMODATE = "Accommodate";
  const EVENT_NAME_CHANGE_RELOCATION_STATUS = "ChangeRelocationStatus";
  const EVENT_NAME_RELOCATE = "Relocate";
  const EVENT_NAME_REQUEST_RELOCATION = "RequestRelocation";
  const EVENT_NAME_SET_ACCOMMODATION_MODE = "SetAccommodationMode";
  const EVENT_NAME_SET_RELOCATION_MODE = "SetRelocationMode";

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_RELOCATION_TOKEN_ADDRESS_IS_ZERO = "ZeroRelocationToken";
  const REVERT_ERROR_IF_RELOCATION_AMOUNT_IS_ZERO = "ZeroRelocationAmount";
  const REVERT_ERROR_IF_RELOCATION_COUNT_IS_ZERO = "ZeroRelocationCount";
  const REVERT_ERROR_IF_LACK_OF_PENDING_RELOCATIONS = "LackOfPendingRelocations";
  const REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED = "UnsupportedRelocation";
  const REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS = "InappropriateRelocationStatus";
  const REVERT_ERROR_IF_CANCELLATION_ARRAY_OF_NONCES_IS_EMPTY = "EmptyCancellationNoncesArray";
  const REVERT_ERROR_IF_INSUFFICIENT_RELOCATION_AMOUNT = "InsufficientRelocationAmount";

  const REVERT_ERROR_IF_ACCOMMODATION_NONCE_IS_ZERO = "ZeroAccommodationNonce";
  const REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH = "AccommodationNonceMismatch";
  const REVERT_ERROR_IF_ACCOMMODATION_ARRAY_OF_RELOCATIONS_IS_EMPTY = "EmptyAccommodationRelocationsArray";
  const REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED = "UnsupportedAccommodation";
  const REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS = "ZeroAccommodationAccount";
  const REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO = "ZeroAccommodationAmount";

  const REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED = "TokenMintingFailure";
  const REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED = "TokenBurningFailure";

  const REVERT_ERROR_IF_ACCOMMODATION_MODE_IS_IMMUTABLE = "AccommodationModeIsImmutable";
  const REVERT_ERROR_IF_ACCOMMODATION_MODE_HAS_NOT_BEEN_CHANGED = "UnchangedAccommodationMode";
  const REVERT_ERROR_IF_RELOCATION_MODE_IS_IMMUTABLE = "RelocationModeIsImmutable";
  const REVERT_ERROR_IF_RELOCATION_MODE_HAS_NOT_BEEN_CHANGED = "UnchangedRelocationMode";
  const REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE = "NonBridgeableToken";

  const OWNER_ROLE: string = ethers.utils.id("OWNER_ROLE");
  const PAUSER_ROLE: string = ethers.utils.id("PAUSER_ROLE");
  const RESCUER_ROLE: string = ethers.utils.id("RESCUER_ROLE");
  const BRIDGER_ROLE: string = ethers.utils.id("BRIDGER_ROLE");

  let multiTokenBridgeFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let multiTokenBridge: Contract;
  let tokenMock1: Contract;
  let tokenMock2: Contract;

  let deployer: SignerWithAddress;
  let bridger: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  let operationMode: OperationMode;

  before(async () => {
    multiTokenBridgeFactory = await ethers.getContractFactory("MultiTokenBridge");
    tokenMockFactory = await ethers.getContractFactory("ERC20UpgradeableMock");

    [deployer, bridger, user1, user2] = await ethers.getSigners();
  });

  async function beforeEachTest(targetOperationMode?: OperationMode) {
    operationMode = targetOperationMode || OperationMode.Unsupported;
    ({ multiTokenBridge, tokenMock1, tokenMock2 } = await setUpFixture(deployAndConfigureContracts));
  }

  async function deployMultiTokenBridge(): Promise<{ multiTokenBridge: Contract }> {
    const multiTokenBridge: Contract = await upgrades.deployProxy(multiTokenBridgeFactory);
    await multiTokenBridge.deployed();
    return { multiTokenBridge };
  }

  async function deployTokenMock(serialNumber: number): Promise<{ tokenMock: Contract }> {
    const name = "ERC20 Test " + serialNumber;
    const symbol = "TEST" + serialNumber;

    const tokenMock: Contract = await upgrades.deployProxy(tokenMockFactory, [name, symbol]);
    await tokenMock.deployed();

    return { tokenMock };
  }

  async function deployAndConfigureContracts(): Promise<{
    multiTokenBridge: Contract,
    tokenMock1: Contract,
    tokenMock2: Contract
  }> {
    const { multiTokenBridge } = await deployMultiTokenBridge();
    const { tokenMock: tokenMock1 } = await deployTokenMock(1);
    const { tokenMock: tokenMock2 } = await deployTokenMock(2);

    await proveTx(multiTokenBridge.grantRole(BRIDGER_ROLE, bridger.address));
    return { multiTokenBridge, tokenMock1, tokenMock2 };
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
      relocation.status = RelocationStatus.Pending;
    }
  }

  async function cancelRelocations(relocations: TestTokenRelocation[]) {
    const noncesPerChainId: Map<number, number[]> = new Map();
    relocations.forEach(relocation => {
      const chainId = relocation.chainId;
      const nonces: number[] = noncesPerChainId.get(chainId) || [];
      nonces.push(relocation.nonce);
      noncesPerChainId.set(chainId, nonces);
      relocation.status = RelocationStatus.Canceled;
    });
    for (const chainId of noncesPerChainId.keys()) {
      const nonces: number[] | undefined = noncesPerChainId.get(chainId);
      if (!nonces) {
        continue;
      }
      await proveTx(multiTokenBridge.connect(bridger).cancelRelocations(chainId, nonces));
    }
  }

  async function pauseMultiTokenBridge() {
    await proveTx(multiTokenBridge.grantRole(PAUSER_ROLE, deployer.address));
    await proveTx(multiTokenBridge.pause());
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

  async function checkBridgeStatesPerChainId(relocations: TestTokenRelocation[]) {
    const expectedChainIds: Set<number> = defineExpectedChainIds(relocations);

    for (let expectedChainId of expectedChainIds) {
      const expectedBridgeState: BridgeStateForChainId =
        defineExpectedBridgeStateForSingleChainId(expectedChainId, relocations);

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

  async function checkBridgeBalancesPerToken(relocations: TestTokenRelocation[]) {
    const expectedTokens: Set<Contract> = defineExpectedTokens(relocations);

    for (const expectedToken of expectedTokens) {
      const expectedBalance: number = countNumberArrayTotal(
        relocations.map(
          function (relocation: TestTokenRelocation): number {
            if (relocation.token == expectedToken
              && !!relocation.requested
              && (operationMode === OperationMode.LockOrTransfer || !relocation.processed)
              && !(relocation.status === RelocationStatus.Canceled || relocation.status === RelocationStatus.Revoked)
            ) {
              return relocation.amount;
            } else {
              return 0;
            }
          }
        )
      );

      const tokenSymbol = await expectedToken.symbol();
      expect(
        await expectedToken.balanceOf(multiTokenBridge.address)
      ).to.equal(
        expectedBalance,
        `Balance is wrong for token with symbol "${tokenSymbol}"`
      );
    }
  }

  async function checkBridgeState(relocations: TestTokenRelocation[]) {
    await checkBridgeStatesPerChainId(relocations);
    await checkRelocationStructures(relocations);
    await checkBridgeBalancesPerToken(relocations);
  }

  async function checkAccommodationTokenTransfers(
    tx: TransactionResponse,
    relocations: TestTokenRelocation[],
    tokenMock: Contract
  ) {
    const relocationAccountAddresses: string[] =
      relocations.map((relocation: TestTokenRelocation) => relocation.account.address);
    const relocationAccountAddressesWithoutDuplicates: string[] = [...new Set(relocationAccountAddresses)];
    const expectedBalanceChangesForTokenMock: number[] = getAmountByTokenAndAddresses(
      relocations,
      tokenMock,
      relocationAccountAddressesWithoutDuplicates,
      RelocationStatus.Processed
    );
    const expectedBridgeBalanceChangeForTokenMock: number = operationMode === OperationMode.LockOrTransfer
      ? countNumberArrayTotal(expectedBalanceChangesForTokenMock)
      : 0;

    await expect(tx).to.changeTokenBalances(
      tokenMock,
      [multiTokenBridge, ...relocationAccountAddressesWithoutDuplicates],
      [-expectedBridgeBalanceChangeForTokenMock, ...expectedBalanceChangesForTokenMock]
    );
  }

  async function checkAccommodationEvents(tx: TransactionResponse, relocations: TestTokenRelocation[]) {
    for (let relocation of relocations) {
      if (relocation.status === RelocationStatus.Processed) {
        await expect(tx).to.emit(
          multiTokenBridge,
          EVENT_NAME_ACCOMMODATE
        ).withArgs(
          CHAIN_ID,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          operationMode
        );
      }
    }
  }

  async function prepareSingleRelocationRequesting(): Promise<{ relocation: TestTokenRelocation }> {
    const relocation: TestTokenRelocation = {
      chainId: CHAIN_ID,
      token: tokenMock1,
      account: user1,
      amount: 456,
      nonce: 1,
    };
    await setUpContractsForRelocations([relocation]);
    return { relocation };
  }

  async function prepareSingleRelocationExecution(): Promise<{ relocation: TestTokenRelocation }> {
    const { relocation } = await prepareSingleRelocationRequesting();
    await requestRelocations([relocation]);
    return { relocation };
  }

  async function prepareSingleRelocationProcessed(): Promise<{ relocation: TestTokenRelocation }> {
    const { relocation } = await prepareSingleRelocationExecution();
    await proveTx(multiTokenBridge.connect(bridger).relocate(relocation.chainId, 1));
    markRelocationsAsProcessed([relocation]);
    return { relocation };
  }

  async function prepareAccommodations(): Promise<{
    relocations: TestTokenRelocation[],
    onChainRelocations: OnChainRelocation[],
    firstRelocationNonce: number
  }> {
    const relocations: TestTokenRelocation[] = [
      {
        chainId: CHAIN_ID,
        token: tokenMock1,
        account: user1,
        amount: 234,
        nonce: 1,
        status: RelocationStatus.Canceled
      },
      {
        chainId: CHAIN_ID,
        token: tokenMock1,
        account: user2,
        amount: 345,
        nonce: 2,
        status: RelocationStatus.Processed
      },
      {
        chainId: CHAIN_ID,
        token: tokenMock2,
        account: user1,
        amount: 456,
        nonce: 3,
        status: RelocationStatus.Aborted
      },
      {
        chainId: CHAIN_ID,
        token: tokenMock2,
        account: user2,
        amount: 567,
        nonce: 4,
        status: RelocationStatus.Processed
      },
      {
        chainId: CHAIN_ID,
        token: tokenMock2,
        account: user2,
        amount: 678,
        nonce: 5,
        status: RelocationStatus.Revoked
      },
      {
        chainId: CHAIN_ID,
        token: tokenMock2,
        account: user2,
        amount: 789,
        nonce: 6,
        status: RelocationStatus.Pending
      },
    ];
    const onChainRelocations: OnChainRelocation[] = relocations.map(toOnChainRelocation);

    await proveTx(
      multiTokenBridge.setAccommodationMode(
        CHAIN_ID,
        tokenMock1.address,
        operationMode
      )
    );
    await proveTx(
      multiTokenBridge.setAccommodationMode(
        CHAIN_ID,
        tokenMock2.address,
        operationMode
      )
    );

    return { relocations, onChainRelocations, firstRelocationNonce: relocations[0].nonce };
  }

  describe("Function 'initialize()'", async () => {
    it("The external initializer configures the contract as expected", async () => {
      await beforeEachTest();

      //The roles
      expect((await multiTokenBridge.OWNER_ROLE()).toLowerCase()).to.equal(OWNER_ROLE);
      expect((await multiTokenBridge.PAUSER_ROLE()).toLowerCase()).to.equal(PAUSER_ROLE);
      expect((await multiTokenBridge.RESCUER_ROLE()).toLowerCase()).to.equal(RESCUER_ROLE);
      expect((await multiTokenBridge.BRIDGER_ROLE()).toLowerCase()).to.equal(BRIDGER_ROLE);

      // The role admins
      expect(await multiTokenBridge.getRoleAdmin(OWNER_ROLE)).to.equal(OWNER_ROLE);
      expect(await multiTokenBridge.getRoleAdmin(PAUSER_ROLE)).to.equal(OWNER_ROLE);
      expect(await multiTokenBridge.getRoleAdmin(RESCUER_ROLE)).to.equal(OWNER_ROLE);
      expect(await multiTokenBridge.getRoleAdmin(BRIDGER_ROLE)).to.equal(OWNER_ROLE);

      // The deployer should have the owner role, but not the other roles
      expect(await multiTokenBridge.hasRole(OWNER_ROLE, deployer.address)).to.equal(true);
      expect(await multiTokenBridge.hasRole(PAUSER_ROLE, deployer.address)).to.equal(false);
      expect(await multiTokenBridge.hasRole(RESCUER_ROLE, deployer.address)).to.equal(false);
      expect(await multiTokenBridge.hasRole(BRIDGER_ROLE, deployer.address)).to.equal(false);

      // The initial contract state is unpaused
      expect(await multiTokenBridge.paused()).to.equal(false);

      // Other constants and settings
      expect(await multiTokenBridge.MINIMUM_RELOCATION_AMOUNT()).to.equal(MINIMUM_RELOCATION_AMOUNT);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      await beforeEachTest();
      await expect(
        multiTokenBridge.initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("Is reverted for the contract implementation if it is called even for the first time", async () => {
      const multiTokenBridgeImplementation: Contract = await multiTokenBridgeFactory.deploy();
      await multiTokenBridgeImplementation.deployed();

      await expect(
        multiTokenBridgeImplementation.initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });
  });

  describe("Configuration", async () => {

    describe("Function 'setRelocationMode()'", async () => {
      it("Executes as expected and emits the correct events in different cases", async () => {
        await beforeEachTest();
        expect(
          await multiTokenBridge.getRelocationMode(CHAIN_ID, tokenMock1.address)
        ).to.equal(OperationMode.Unsupported);

        await expect(
          multiTokenBridge.setRelocationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.BurnOrMint
          )
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_RELOCATION_MODE
        ).withArgs(
          CHAIN_ID,
          tokenMock1.address,
          OperationMode.Unsupported,
          OperationMode.BurnOrMint
        );
        expect(
          await multiTokenBridge.getRelocationMode(CHAIN_ID, tokenMock1.address)
        ).to.equal(OperationMode.BurnOrMint);

        expect(
          await multiTokenBridge.getRelocationMode(CHAIN_ID, tokenMock2.address)
        ).to.equal(OperationMode.Unsupported);

        await expect(
          multiTokenBridge.setRelocationMode(
            CHAIN_ID,
            tokenMock2.address,
            OperationMode.LockOrTransfer
          )
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_RELOCATION_MODE
        ).withArgs(
          CHAIN_ID,
          tokenMock2.address,
          OperationMode.Unsupported,
          OperationMode.LockOrTransfer
        );
        expect(
          await multiTokenBridge.getRelocationMode(CHAIN_ID, tokenMock2.address)
        ).to.equal(OperationMode.LockOrTransfer);
      });

      it("Is reverted if it is called not by the account with the owner role", async () => {
        await beforeEachTest();
        await expect(
          multiTokenBridge.connect(user1).setRelocationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, OWNER_ROLE));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        await beforeEachTest();
        await expect(
          multiTokenBridge.setRelocationMode(
            CHAIN_ID,
            FAKE_TOKEN_ADDRESS,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE);
      });

      it("Is reverted if the call does not changed the relocation mode", async () => {
        await beforeEachTest();
        await expect(
          multiTokenBridge.setRelocationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.Unsupported
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_MODE_HAS_NOT_BEEN_CHANGED
        );
      });

      it("Is reverted if the relocation mode has already been set", async () => {
        await beforeEachTest();
        await proveTx(multiTokenBridge.setRelocationMode(
          CHAIN_ID,
          tokenMock1.address,
          OperationMode.BurnOrMint
        ));

        await expect(
          multiTokenBridge.setRelocationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.Unsupported
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_MODE_IS_IMMUTABLE
        );
      });
    });

    describe("Function 'setAccommodationMode()'", async () => {
      it("Executes as expected and emits the correct events in different cases", async () => {
        await beforeEachTest();
        expect(
          await multiTokenBridge.getAccommodationMode(CHAIN_ID, tokenMock1.address)
        ).to.equal(OperationMode.Unsupported);

        await expect(
          multiTokenBridge.setAccommodationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.BurnOrMint
          )
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_ACCOMMODATION_MODE
        ).withArgs(
          CHAIN_ID,
          tokenMock1.address,
          OperationMode.Unsupported,
          OperationMode.BurnOrMint
        );
        expect(
          await multiTokenBridge.getAccommodationMode(CHAIN_ID, tokenMock1.address)
        ).to.equal(OperationMode.BurnOrMint);

        expect(
          await multiTokenBridge.getAccommodationMode(CHAIN_ID, tokenMock2.address)
        ).to.equal(OperationMode.Unsupported);

        await expect(
          multiTokenBridge.setAccommodationMode(
            CHAIN_ID,
            tokenMock2.address,
            OperationMode.LockOrTransfer
          )
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_ACCOMMODATION_MODE
        ).withArgs(
          CHAIN_ID,
          tokenMock2.address,
          OperationMode.Unsupported,
          OperationMode.LockOrTransfer
        );
        expect(
          await multiTokenBridge.getAccommodationMode(CHAIN_ID, tokenMock2.address)
        ).to.equal(OperationMode.LockOrTransfer);
      });

      it("Is reverted if it is called not by the account with the owner role", async () => {
        await beforeEachTest();
        await expect(
          multiTokenBridge.connect(user1).setAccommodationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, OWNER_ROLE));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        await beforeEachTest();
        await expect(
          multiTokenBridge.setAccommodationMode(
            CHAIN_ID,
            FAKE_TOKEN_ADDRESS,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE);
      });

      it("Is reverted if the call does not changed the accommodation mode", async () => {
        await beforeEachTest();
        await expect(
          multiTokenBridge.setAccommodationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.Unsupported
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_ACCOMMODATION_MODE_HAS_NOT_BEEN_CHANGED
        );
      });

      it("Is reverted if the accommodation mode has already been set", async () => {
        await beforeEachTest();
        await proveTx(multiTokenBridge.setAccommodationMode(
          CHAIN_ID,
          tokenMock1.address,
          OperationMode.BurnOrMint
        ));

        await expect(
          multiTokenBridge.setAccommodationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.Unsupported
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_ACCOMMODATION_MODE_IS_IMMUTABLE
        );
      });
    });
  });

  describe("Interactions related to relocations in the BurnOrMint operation mode", async () => {
    describe("Function 'requestRelocation()'", async () => {
      async function beforeExecutionOfRequestRelocation(): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationRequesting();
      }

      it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
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
          EVENT_NAME_REQUEST_RELOCATION
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce
        );
        relocation.requested = true;
        relocation.status = RelocationStatus.Pending;
        await checkBridgeState([relocation]);
      });

      it("Is reverted if the contract is paused", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
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
        const { relocation } = await beforeExecutionOfRequestRelocation();
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            ethers.constants.AddressZero,
            relocation.amount
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_TOKEN_ADDRESS_IS_ZERO);
      });

      it("Is reverted if the token amount of the relocation is zero", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            0
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_AMOUNT_IS_ZERO);
      });

      it("Is reverted if the token amount of the relocation is less than minimum allowed one", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            MINIMUM_RELOCATION_AMOUNT - 1
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_INSUFFICIENT_RELOCATION_AMOUNT);
      });

      it("Is reverted if the target chain is unsupported for relocations", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId + 1,
            relocation.token.address,
            relocation.amount
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the token is unsupported for relocations", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            tokenMock2.address,
            relocation.amount
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the user has not enough token balance", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
        const excessTokenAmount: number = relocation.amount + 1;

        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            excessTokenAmount
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });
    });

    describe("Function 'cancelRelocations()'", async () => {
      async function beforeExecutionOfCancelRelocations(): Promise<{
        relocations: TestTokenRelocation[],
        relocationNonces: number[]
      }> {
        await beforeEachTest(OperationMode.BurnOrMint);

        const relocations: TestTokenRelocation[] = [
          {
            chainId: CHAIN_ID,
            token: tokenMock1,
            account: user1,
            amount: 3456,
            nonce: 1,
          },
          {
            chainId: CHAIN_ID,
            token: tokenMock2,
            account: user2,
            amount: 5678,
            nonce: 2,
          },
        ];

        const relocationNonces: number[] = relocations.map((relocation: TestTokenRelocation) => relocation.nonce);
        await setUpContractsForRelocations(relocations);
        await requestRelocations(relocations);

        return { relocations, relocationNonces };
      }

      async function checkTokenTransfers(
        tx: TransactionResponse,
        relocations: TestTokenRelocation[],
        tokenMock: Contract
      ) {
        const relocationAccountAddresses: string[] =
          relocations.map((relocation: TestTokenRelocation) => relocation.account.address);
        const expectedAccountBalanceChangesForTokenMock: number[] = getAmountByTokenAndAddresses(
          relocations,
          tokenMock,
          relocationAccountAddresses,
          RelocationStatus.Pending
        );
        const expectedBridgeBalanceChangeForTokenMock =
          countNumberArrayTotal(expectedAccountBalanceChangesForTokenMock);

        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [multiTokenBridge, ...relocationAccountAddresses],
          [-expectedBridgeBalanceChangeForTokenMock, ...expectedAccountBalanceChangesForTokenMock]
        );
      }

      async function checkEvent(tx: TransactionResponse, relocation: TestTokenRelocation) {
        await expect(tx).to.emit(
          multiTokenBridge,
          EVENT_NAME_CHANGE_RELOCATION_STATUS
        ).withArgs(
          CHAIN_ID,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          RelocationStatus.Canceled,
          RelocationStatus.Pending
        );
      }

      it("Transfers the tokens as expected, emits the correct events, changes the state properly", async () => {
        const { relocations, relocationNonces } = await beforeExecutionOfCancelRelocations();
        await checkBridgeState(relocations);

        const tx: TransactionResponse =
          await multiTokenBridge.connect(bridger).cancelRelocations(CHAIN_ID, relocationNonces);
        await checkEvent(tx, relocations[0]);
        await checkEvent(tx, relocations[1]);
        await checkTokenTransfers(tx, relocations, tokenMock1);
        await checkTokenTransfers(tx, relocations, tokenMock2);

        relocations.forEach(
          (relocation: TestTokenRelocation) => relocation.status = RelocationStatus.Canceled
        );
        await checkBridgeState(relocations);
      });

      it("Is reverted if the contract is paused", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await pauseMultiTokenBridge();

        await expect(
          multiTokenBridge.connect(bridger).cancelRelocations(CHAIN_ID, [])
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await expect(
          multiTokenBridge.connect(deployer).cancelRelocations(CHAIN_ID, [])
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
      });

      it("Is reverted if the input array of nonces is empty", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await expect(
          multiTokenBridge.connect(bridger).cancelRelocations(CHAIN_ID, [])
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_CANCELLATION_ARRAY_OF_NONCES_IS_EMPTY);
      });

      it("Is reverted if some input nonce belongs to a processed relocation", async () => {
        const { relocationNonces, relocations } = await beforeExecutionOfCancelRelocations();
        await proveTx(multiTokenBridge.connect(bridger).relocate(relocations[0].chainId, 1));

        await expect(multiTokenBridge.connect(bridger).cancelRelocations(
          CHAIN_ID,
          relocationNonces
        )).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Processed);
      });

      it("Is reverted if some input nonce belongs to a nonexistent relocation", async () => {
        const { relocationNonces } = await beforeExecutionOfCancelRelocations();
        await expect(multiTokenBridge.connect(bridger).cancelRelocations(
          CHAIN_ID,
          [
            Math.max(...relocationNonces) + 1,
            ...relocationNonces
          ]
        )).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Nonexistent);
      });

      it("Is reverted if a relocation with some nonce was already canceled", async () => {
        const { relocations, relocationNonces } = await beforeExecutionOfCancelRelocations();
        await cancelRelocations([relocations[1]]);

        await expect(
          multiTokenBridge.connect(bridger).cancelRelocations(CHAIN_ID, relocationNonces)
        ).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Canceled);
      });

      it("Is reverted if some input nonce belongs to an aborted relocation", async () => {
        const { relocationNonces, relocations } = await beforeExecutionOfCancelRelocations();
        await proveTx(multiTokenBridge.connect(bridger).relocate(relocations[0].chainId, 1));
        await proveTx(multiTokenBridge.connect(bridger).abortRelocation(relocations[0].chainId, relocations[0].nonce));

        await expect(multiTokenBridge.connect(bridger).cancelRelocations(
          CHAIN_ID,
          relocationNonces
        )).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Aborted);
      });

      it("Is reverted if some input nonce belongs to a revoked relocation", async () => {
        const { relocationNonces, relocations } = await beforeExecutionOfCancelRelocations();
        await proveTx(multiTokenBridge.connect(bridger).relocate(relocations[0].chainId, 1));
        await proveTx(multiTokenBridge.connect(bridger).revokeRelocation(relocations[0].chainId, relocations[0].nonce));

        await expect(multiTokenBridge.connect(bridger).cancelRelocations(
          CHAIN_ID,
          relocationNonces
        )).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Revoked);
      });
    });

    describe("Function 'relocate()'", async () => {
      const relocationCount = 1;

      async function beforeExecutionOfRelocate(): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationExecution();
      }

      it("Burns tokens as expected, emits the correct event, changes the state properly", async () => {
        const { relocation } = await beforeExecutionOfRelocate();
        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, user1, user2],
          [-relocation.amount, 0, 0]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_RELOCATE
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

      async function checkExecutionIfRelocationCanceled(relocation: TestTokenRelocation) {
        await checkBridgeState([relocation]);
        const balanceBefore: BigNumber = await tokenMock1.balanceOf(multiTokenBridge.address);

        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount)
        ).and.not.to.emit(
          multiTokenBridge,
          EVENT_NAME_RELOCATE
        );

        const balanceAfter: BigNumber = await tokenMock1.balanceOf(multiTokenBridge.address);
        expect(balanceAfter.sub(balanceBefore)).to.equal(0);
        markRelocationsAsProcessed([relocation]);
        await checkBridgeState([relocation]);
      }

      it("Burns no tokens, emits no events if the relocation was canceled", async () => {
        const { relocation } = await beforeExecutionOfRelocate();
        await cancelRelocations([relocation]);
        await checkExecutionIfRelocationCanceled(relocation);
      });

      it("Is reverted if the contract is paused", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await pauseMultiTokenBridge();

        await expect(
          multiTokenBridge.connect(bridger).relocate(CHAIN_ID, relocationCount)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await expect(
          multiTokenBridge.connect(deployer).relocate(CHAIN_ID, relocationCount)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
      });

      it("Is reverted if the relocation count is zero", async () => {
        const { relocation } = await beforeExecutionOfRelocate();
        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, 0)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_COUNT_IS_ZERO);
      });

      it("Is reverted if the relocation count exceeds the number of pending relocations", async () => {
        const { relocation } = await beforeExecutionOfRelocate();
        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount + 1)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_LACK_OF_PENDING_RELOCATIONS);
      });

      it("Is reverted if burning of tokens had failed", async () => {
        const { relocation } = await beforeExecutionOfRelocate();
        await proveTx(tokenMock1.disableBurningForBridging());

        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount)
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED);
      });
    });

    describe("Function 'abortRelocation()'", async () => {
      async function beforeExecutionOfAbortRelocation(): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationProcessed();
      }

      it("Transfers no tokens, emits the correct event, changes the state properly", async () => {
        const { relocation } = await beforeExecutionOfAbortRelocation();
        await checkBridgeState([relocation]);

        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account],
          [0, 0]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_CHANGE_RELOCATION_STATUS
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          RelocationStatus.Aborted,
          RelocationStatus.Processed
        );
        relocation.status = RelocationStatus.Aborted;
        await checkBridgeState([relocation]);
      });

      it("Is reverted if the contract is paused", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await pauseMultiTokenBridge();

        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(CHAIN_ID, 0)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await expect(
          multiTokenBridge.abortRelocation(CHAIN_ID, 0)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
      });

      it("Is reverted if a relocation with the nonce does not exists", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(CHAIN_ID, 0)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Nonexistent
        );
      });

      it("Is reverted if a relocation with the nonce is pending", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        const { relocation } = await prepareSingleRelocationExecution();

        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Pending
        );
      });

      it("Is reverted if a relocation with the nonce is already aborted", async () => {
        const { relocation } = await beforeExecutionOfAbortRelocation();
        await proveTx(multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce));

        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Aborted
        );
      });

      it("Is reverted if a relocation with the nonce is revoked", async () => {
        const { relocation } = await beforeExecutionOfAbortRelocation();
        await proveTx(multiTokenBridge.connect(bridger).revokeRelocation(relocation.chainId, relocation.nonce));

        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Revoked
        );
      });
    });

    describe("Function 'revokeRelocation()'", async () => {
      async function beforeExecutionOfRevokeRelocation(): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationProcessed();
      }

      it("Mints tokens as expected, emits the correct event, changes the state properly", async () => {
        const { relocation } = await beforeExecutionOfRevokeRelocation();
        await checkBridgeState([relocation]);

        await expect(
          multiTokenBridge.connect(bridger).revokeRelocation(relocation.chainId, relocation.nonce)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account],
          [0, +relocation.amount]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_CHANGE_RELOCATION_STATUS
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          RelocationStatus.Revoked,
          RelocationStatus.Processed
        );
        relocation.status = RelocationStatus.Revoked;
        await checkBridgeState([relocation]);
      });

      it("Is reverted if the contract is paused", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await pauseMultiTokenBridge();

        await expect(
          multiTokenBridge.connect(bridger).revokeRelocation(CHAIN_ID, 0)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await expect(
          multiTokenBridge.revokeRelocation(CHAIN_ID, 0)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
      });

      it("Is reverted if a relocation with the nonce does not exists", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        await expect(
          multiTokenBridge.connect(bridger).revokeRelocation(CHAIN_ID, 0)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Nonexistent
        );
      });

      it("Is reverted if a relocation with the nonce is pending", async () => {
        await beforeEachTest(OperationMode.BurnOrMint);
        const { relocation } = await prepareSingleRelocationExecution();

        await expect(
          multiTokenBridge.connect(bridger).revokeRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Pending
        );
      });

      it("Is reverted if a relocation with the nonce is aborted", async () => {
        const { relocation } = await beforeExecutionOfRevokeRelocation();
        await proveTx(multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce));

        await expect(
          multiTokenBridge.connect(bridger).revokeRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Aborted
        );
      });

      it("Is reverted if a relocation with the nonce is already revoked", async () => {
        const { relocation } = await beforeExecutionOfRevokeRelocation();
        await proveTx(multiTokenBridge.connect(bridger).revokeRelocation(relocation.chainId, relocation.nonce));

        await expect(
          multiTokenBridge.connect(bridger).revokeRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          RelocationStatus.Revoked
        );
      });
    });

    describe("Complex scenario for a single chain with several tokens", async () => {
      async function beforeComplexScenarioForSingleChain(): Promise<{ relocations: TestTokenRelocation[] }> {
        await beforeEachTest(OperationMode.BurnOrMint);
        const relocations: TestTokenRelocation[] = [
          {
            chainId: CHAIN_ID,
            token: tokenMock1,
            account: user1,
            amount: 234,
            nonce: 1,
          },
          {
            chainId: CHAIN_ID,
            token: tokenMock2,
            account: user1,
            amount: 345,
            nonce: 2,
          },
          {
            chainId: CHAIN_ID,
            token: tokenMock2,
            account: user2,
            amount: 456,
            nonce: 3,
          },
          {
            chainId: CHAIN_ID,
            token: tokenMock1,
            account: deployer,
            amount: 567,
            nonce: 4,
          },
        ];
        await setUpContractsForRelocations(relocations);
        return { relocations };
      }

      it("Executes as expected", async () => {
        const { relocations } = await beforeComplexScenarioForSingleChain();

        // Request first 3 relocations
        await requestRelocations([relocations[0], relocations[1], relocations[2]]);
        await checkBridgeState(relocations);

        // Process the first relocation
        await proveTx(multiTokenBridge.connect(bridger).relocate(CHAIN_ID, 1));
        markRelocationsAsProcessed([relocations[0]]);
        await checkBridgeState(relocations);

        // Try to cancel already processed relocation
        await expect(
          multiTokenBridge.connect(bridger).cancelRelocations(CHAIN_ID, [relocations[0].nonce])
        ).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Processed);

        // Try to cancel several relocations including the processed one
        await expect(
          multiTokenBridge.connect(bridger).cancelRelocations(CHAIN_ID, [
            relocations[2].nonce,
            relocations[1].nonce,
            relocations[0].nonce,
          ])
        ).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Processed);

        // Try to cancel several relocations including one that is out of the pending range
        await expect(
          multiTokenBridge.connect(bridger).cancelRelocations(CHAIN_ID, [
            relocations[3].nonce,
            relocations[2].nonce,
            relocations[1].nonce,
          ])
        ).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Nonexistent);

        // Check that state of the bridge has not changed
        await checkBridgeState(relocations);

        // Request another relocation
        await requestRelocations([relocations[3]]);
        await checkBridgeState(relocations);

        // Cancel two last relocations by the bridger
        await proveTx(
          multiTokenBridge.connect(bridger).cancelRelocations(
            CHAIN_ID,
            [relocations[3].nonce, relocations[2].nonce]
          )
        );
        [relocations[3], relocations[2]].forEach(
          (relocation: TestTokenRelocation) => relocation.status = RelocationStatus.Canceled
        );
        await checkBridgeState(relocations);

        // Process all the pending relocations
        await proveTx(multiTokenBridge.connect(bridger).relocate(CHAIN_ID, 3));
        markRelocationsAsProcessed(relocations);
        await checkBridgeState(relocations);

        // Revoke the second relocation
        await proveTx(multiTokenBridge.connect(bridger).revokeRelocation(CHAIN_ID, relocations[1].nonce));
        relocations[1].status = RelocationStatus.Revoked;
        await checkBridgeState(relocations);

        // Abort the first relocation
        await proveTx(multiTokenBridge.connect(bridger).abortRelocation(CHAIN_ID, relocations[0].nonce));
        relocations[0].status = RelocationStatus.Aborted;
        await checkBridgeState(relocations);
      });
    });

    describe("Complex scenario for several chains with several tokens", async () => {
      const chainId1 = 123;
      const chainId2 = 234;

      async function beforeComplexScenarioForSeveralChains(): Promise<{
        relocations: TestTokenRelocation[],
        relocationCountByChainId: number[]
      }> {
        await beforeEachTest(OperationMode.BurnOrMint);
        const relocations: TestTokenRelocation[] = [
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
        const relocationCountByChainId: number[] = [];
        relocationCountByChainId[chainId1] = countRelocationsForChainId(relocations, chainId1);
        relocationCountByChainId[chainId2] = countRelocationsForChainId(relocations, chainId2);
        await setUpContractsForRelocations(relocations);

        return { relocations, relocationCountByChainId };
      }

      it("Executes as expected", async () => {
        const { relocations, relocationCountByChainId } = await beforeComplexScenarioForSeveralChains();

        // Request all relocations
        await requestRelocations(relocations);
        await checkBridgeState(relocations);

        // Cancel some relocations
        await cancelRelocations([relocations[1], relocations[2]]);
        await checkBridgeState(relocations);

        // Process all the pending relocations in all the chains
        await proveTx(multiTokenBridge.connect(bridger).relocate(chainId1, relocationCountByChainId[chainId1]));
        await proveTx(multiTokenBridge.connect(bridger).relocate(chainId2, relocationCountByChainId[chainId2]));
        markRelocationsAsProcessed(relocations);
        await checkBridgeState(relocations);
      });
    });
  });

  describe("Interactions related to relocations in the LockOrTransfer operation mode", async () => {
    describe("Function 'requestRelocation()'", async () => {
      async function beforeExecutionOfRequestRelocation(): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachTest(OperationMode.LockOrTransfer);
        return prepareSingleRelocationRequesting();
      }

      it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
        const { relocation } = await beforeExecutionOfRequestRelocation();
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
          EVENT_NAME_REQUEST_RELOCATION
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce
        );
        relocation.requested = true;
        relocation.status = RelocationStatus.Pending;
        await checkBridgeState([relocation]);
      });
    });

    describe("Function 'relocate()'", async () => {
      const relocationCount = 1;

      async function beforeExecutionOfRelocate(): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachTest(OperationMode.LockOrTransfer);
        return prepareSingleRelocationExecution();
      }

      it("Burns no tokens, emits the correct event, changes the state properly", async () => {
        const { relocation } = await beforeExecutionOfRelocate();
        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          relocation.token,
          [multiTokenBridge, relocation.account],
          [0, 0]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_RELOCATE
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

    describe("Function 'revokeRelocation()'", async () => {
      async function beforeExecutionOfRevokeRelocation(): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachTest(OperationMode.LockOrTransfer);
        return prepareSingleRelocationProcessed();
      }

      it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
        const { relocation } = await beforeExecutionOfRevokeRelocation();
        await checkBridgeState([relocation]);

        await expect(
          multiTokenBridge.connect(bridger).revokeRelocation(relocation.chainId, relocation.nonce)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account],
          [-relocation.amount, +relocation.amount]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_CHANGE_RELOCATION_STATUS
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          RelocationStatus.Revoked,
          RelocationStatus.Processed
        );
        relocation.status = RelocationStatus.Revoked;
        await checkBridgeState([relocation]);
      });
    });
  });

  describe("Interactions related to accommodations in the BurnOrMint operation mode", async () => {
    describe("Function 'accommodate()'", async () => {
      async function beforeExecutionOfAccommodate(): Promise<{
        relocations: TestTokenRelocation[],
        onChainRelocations: OnChainRelocation[],
        firstRelocationNonce: number
      }> {
        await beforeEachTest(OperationMode.BurnOrMint);
        return prepareAccommodations();
      }

      it("Mints tokens as expected, emits the correct events, changes the state properly", async () => {
        const { relocations, onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();

        const tx: TransactionResponse = await multiTokenBridge.connect(bridger).accommodate(
          CHAIN_ID,
          firstRelocationNonce,
          onChainRelocations
        );
        await checkAccommodationEvents(tx, relocations);
        await checkAccommodationTokenTransfers(tx, relocations, tokenMock1);
        await checkAccommodationTokenTransfers(tx, relocations, tokenMock2);
        expect(
          await multiTokenBridge.getLastAccommodationNonce(CHAIN_ID)
        ).to.equal(relocations[relocations.length - 1].nonce);
      });

      it("Is reverted if the contract is paused", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        await pauseMultiTokenBridge();

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(deployer).accommodate(
            CHAIN_ID,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
      });

      it("Is reverted if the chain is unsupported for accommodations", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID + 1,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED);
      });

      it("Is reverted if one of the token contracts is unsupported for accommodations", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        onChainRelocations[1].token = FAKE_TOKEN_ADDRESS;

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the first relocation nonce is zero", async () => {
        const { onChainRelocations } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            0,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_NONCE_IS_ZERO);
      });

      it("Is reverted if the first relocation nonce does not equal the last accommodation nonce +1", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstRelocationNonce + 1,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH);
      });

      it("Is reverted if the input array of relocations is empty", async () => {
        const { firstRelocationNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstRelocationNonce,
            []
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_ARRAY_OF_RELOCATIONS_IS_EMPTY);
      });

      it("Is reverted if one of the input accounts has zero address", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        onChainRelocations[1].account = ethers.constants.AddressZero;

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS);
      });

      it("Is reverted if one of the input amounts is zero", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        onChainRelocations[1].amount = ethers.constants.Zero;

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO);
      });

      it("Is reverted if minting of tokens had failed", async () => {
        const { onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        await proveTx(tokenMock1.disableMintingForBridging());

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstRelocationNonce,
            onChainRelocations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED);
      });
    });
  });

  describe("Interactions related to accommodations in the LockOrTransfer operation mode", async () => {
    describe("Function 'accommodate()'", async () => {
      async function beforeExecutionOfAccommodate(): Promise<{
        relocations: TestTokenRelocation[],
        onChainRelocations: OnChainRelocation[],
        firstRelocationNonce: number
      }> {
        await beforeEachTest(OperationMode.LockOrTransfer);
        return prepareAccommodations();
      }

      it("Transfers tokens as expected, emits the correct events, changes the state properly", async () => {
        const { relocations, onChainRelocations, firstRelocationNonce } = await beforeExecutionOfAccommodate();
        await proveTx(tokenMock1.mint(multiTokenBridge.address, ethers.constants.MaxUint256));
        await proveTx(tokenMock2.mint(multiTokenBridge.address, ethers.constants.MaxUint256));

        const tx: TransactionResponse = multiTokenBridge.connect(bridger).accommodate(
          CHAIN_ID,
          firstRelocationNonce,
          onChainRelocations
        );
        await checkAccommodationEvents(tx, relocations);
        await checkAccommodationTokenTransfers(tx, relocations, tokenMock1);
        await checkAccommodationTokenTransfers(tx, relocations, tokenMock2);

        expect(
          await multiTokenBridge.getLastAccommodationNonce(CHAIN_ID)
        ).to.equal(relocations[relocations.length - 1].nonce);
      });
    });
  });
});
