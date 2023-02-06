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
  Rejected = 4,
  Aborted = 5,
  Postponed = 6,
  Continued = 7,
}

enum FeeRefundMode {
  Nothing = 0,
  Full = 1,
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
  oldNonce?: number;
  newNonce?: number;
  fee?: number;
  feeRefundMode?: FeeRefundMode;
  refundedFee?: number;
}

interface OnChainRelocation {
  token: string;
  account: string;
  amount: BigNumber;
  status: RelocationStatus;
  oldNonce: number;
  newNonce: number;
}

interface OnChainAccommodation {
  token: string;
  account: string;
  amount: BigNumber;
  status: RelocationStatus;
}

const defaultOnChainRelocation: OnChainRelocation = {
  token: ethers.constants.AddressZero,
  account: ethers.constants.AddressZero,
  amount: ethers.constants.Zero,
  status: RelocationStatus.Nonexistent,
  oldNonce: 0,
  newNonce: 0
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
    oldNonce: relocation.oldNonce || 0,
    newNonce: relocation.newNonce || 0
  };
}

function toOnChainAccommodation(relocation: TestTokenRelocation): OnChainAccommodation {
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
  expect(actualOnChainRelocation.oldNonce).to.equal(
    expectedRelocation.oldNonce,
    `relocation[${relocationIndex}].oldNonce is incorrect, chainId=${chainId}`
  );
  expect(actualOnChainRelocation.newNonce).to.equal(
    expectedRelocation.newNonce,
    `relocation[${relocationIndex}].newNonce is incorrect, chainId=${chainId}`
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
  const FAKE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000001";
  const FAKE_FEE_ORACLE_ADDRESS = "0x0000000000000000000000000000000000000002";
  const FAKE_FEE_COLLECTOR_ADDRESS = "0x0000000000000000000000000000000000000003";
  const FAKE_GUARD_ADDRESS = "0x0000000000000000000000000000000000000004";
  const CHAIN_ID = 123;

  const EVENT_NAME_ABORT_RELOCATION = "AbortRelocation";
  const EVENT_NAME_ACCOMMODATE = "Accommodate";
  const EVENT_NAME_CANCEL_RELOCATION = "CancelRelocation";
  const EVENT_NAME_CONTINUE_RELOCATION = "ContinueRelocation";
  const EVENT_NAME_POSTPONE_RELOCATION = "PostponeRelocation";
  const EVENT_NAME_REJECT_RELOCATION = "RejectRelocation";
  const EVENT_NAME_RELOCATE = "Relocate";
  const EVENT_NAME_REQUEST_RELOCATION = "RequestRelocation";
  const EVENT_NAME_SET_ACCOMMODATION_MODE = "SetAccommodationMode";
  const EVENT_NAME_SET_GUARD = "SetGuard";
  const EVENT_NAME_SET_FEE_COLLECTOR = "SetFeeCollector";
  const EVENT_NAME_SET_FEE_ORACLE = "SetFeeOracle";
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

  const REVERT_ERROR_IF_ACCOMMODATION_NONCE_IS_ZERO = "ZeroAccommodationNonce";
  const REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH = "AccommodationNonceMismatch";
  const REVERT_ERROR_IF_ACCOMMODATION_ARRAY_OF_RELOCATIONS_IS_EMPTY = "EmptyAccommodationRelocationsArray";
  const REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED = "UnsupportedAccommodation";
  const REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS = "ZeroAccommodationAccount";
  const REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO = "ZeroAccommodationAmount";
  const REVERT_ERROR_IF_ACCOMMODATION_GUARD_BAN = "AccommodationGuardBan";

  const REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED = "TokenMintingFailure";
  const REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED = "TokenBurningFailure";

  const REVERT_ERROR_IF_ACCOMMODATION_MODE_IS_IMMUTABLE = "AccommodationModeIsImmutable";
  const REVERT_ERROR_IF_ACCOMMODATION_MODE_HAS_NOT_BEEN_CHANGED = "UnchangedAccommodationMode";
  const REVERT_ERROR_IF_GUARD_HAS_NOT_BEEN_CHANGED = "UnchangedGuard";
  const REVERT_ERROR_IF_FEE_COLLECTOR_HAS_NOT_BEEN_CHANGED = "UnchangedFeeCollector";
  const REVERT_ERROR_IF_FEE_ORACLE_HAS_NOT_BEEN_CHANGED = "UnchangedFeeOracle";
  const REVERT_ERROR_IF_RELOCATION_MODE_IS_IMMUTABLE = "RelocationModeIsImmutable";
  const REVERT_ERROR_IF_RELOCATION_MODE_HAS_NOT_BEEN_CHANGED = "UnchangedRelocationMode";
  const REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE = "NonBridgeableToken";

  const OWNER_ROLE: string = ethers.utils.id("OWNER_ROLE");
  const PAUSER_ROLE: string = ethers.utils.id("PAUSER_ROLE");
  const RESCUER_ROLE: string = ethers.utils.id("RESCUER_ROLE");
  const BRIDGER_ROLE: string = ethers.utils.id("BRIDGER_ROLE");

  let multiTokenBridgeFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;
  let feeOracleMockFactory: ContractFactory;
  let guardMockFactory: ContractFactory;

  let multiTokenBridge: Contract;
  let tokenMock1: Contract;
  let tokenMock2: Contract;
  let feeOracleMock: Contract;
  let guardMock: Contract;

  let deployer: SignerWithAddress;
  let bridger: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let feeCollector: SignerWithAddress;

  let operationMode: OperationMode;

  before(async () => {
    multiTokenBridgeFactory = await ethers.getContractFactory("MultiTokenBridge");
    tokenMockFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    feeOracleMockFactory = await ethers.getContractFactory("BridgeFeeOracleMock");
    guardMockFactory = await ethers.getContractFactory("BridgeGuardMock");

    [deployer, bridger, user1, user2, feeCollector] = await ethers.getSigners();
  });

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

  async function deployFeeOracleMock(): Promise<{ feeOracleMock: Contract }> {
    const feeOracleMock: Contract = await feeOracleMockFactory.deploy();
    await feeOracleMock.deployed();

    return { feeOracleMock };
  }

  async function deployGuardMock(): Promise<{ guardMock: Contract }> {
    const guardMock: Contract = await guardMockFactory.deploy();
    await guardMock.deployed();

    return { guardMock };
  }

  async function deployBridgeAndTokenMockContracts(): Promise<{
    multiTokenBridge: Contract,
    tokenMock1: Contract,
    tokenMock2: Contract,
  }> {
    const { multiTokenBridge } = await deployMultiTokenBridge();
    const { tokenMock: tokenMock1 } = await deployTokenMock(1);
    const { tokenMock: tokenMock2 } = await deployTokenMock(2);

    return { multiTokenBridge, tokenMock1, tokenMock2 };
  }

  async function deployAndConfigureAllContracts(): Promise<{
    multiTokenBridge: Contract,
    tokenMock1: Contract,
    tokenMock2: Contract,
    feeOracleMock: Contract,
    guardMock: Contract
  }> {
    const { multiTokenBridge } = await deployMultiTokenBridge();
    const { tokenMock: tokenMock1 } = await deployTokenMock(1);
    const { tokenMock: tokenMock2 } = await deployTokenMock(2);
    const { feeOracleMock } = await deployFeeOracleMock();
    const { guardMock } = await deployGuardMock();

    await proveTx(multiTokenBridge.grantRole(BRIDGER_ROLE, bridger.address));
    await proveTx(multiTokenBridge.setFeeOracle(feeOracleMock.address));

    return { multiTokenBridge, tokenMock1, tokenMock2, feeOracleMock, guardMock };
  }

  async function beforeEachConfigurationTest() {
    operationMode = OperationMode.Unsupported;
    ({ multiTokenBridge, tokenMock1, tokenMock2 } = await setUpFixture(deployBridgeAndTokenMockContracts));
  }

  async function beforeEachNonConfigurationTest(targetOperationMode: OperationMode) {
    operationMode = targetOperationMode;
    (
      { multiTokenBridge, tokenMock1, tokenMock2, feeOracleMock, guardMock } =
        await setUpFixture(deployAndConfigureAllContracts)
    );
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
      await proveTx(relocation.token.mint(relocation.account.address, relocation.amount + (relocation.fee || 0)));
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
    for (const relocation of relocations) {
      await proveTx(
        multiTokenBridge.connect(bridger).cancelRelocation(
          relocation.chainId,
          relocation.nonce,
          relocation.feeRefundMode || FeeRefundMode.Nothing
        )
      );
      relocation.status = RelocationStatus.Canceled;
      relocation.fee = (relocation.fee || 0) - (relocation.refundedFee || 0);
    }
  }

  async function rejectRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        multiTokenBridge.connect(bridger).rejectRelocation(
          relocation.chainId,
          relocation.nonce,
          relocation.feeRefundMode || FeeRefundMode.Nothing
        )
      );
      relocation.status = RelocationStatus.Rejected;
      relocation.fee = (relocation.fee || 0) - (relocation.refundedFee || 0);
    }
  }

  async function abortRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce)
      );
      relocation.status = RelocationStatus.Aborted;
    }
  }

  async function postponeRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        multiTokenBridge.connect(bridger).postponeRelocation(relocation.chainId, relocation.nonce)
      );
      relocation.status = RelocationStatus.Postponed;
    }
  }

  async function continueRelocations(relocations: TestTokenRelocation[]) {
    for (const relocation of relocations) {
      await proveTx(
        multiTokenBridge.connect(bridger).continueRelocation(relocation.chainId, relocation.nonce)
      );
      relocation.status = RelocationStatus.Continued;
    }
  }

  function treatRelocationAsLastOneBeforeContinuing(relocation: TestTokenRelocation): TestTokenRelocation {
    const newRelocation: TestTokenRelocation = { ...relocation };

    newRelocation.status = RelocationStatus.Pending;
    newRelocation.nonce = relocation.nonce + 1;
    newRelocation.oldNonce = relocation.nonce;
    newRelocation.fee = relocation.fee;

    relocation.fee = 0;
    relocation.newNonce = relocation.nonce + 1;

    return newRelocation;
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
            if (relocation.token == expectedToken && !!relocation.requested) {
              if (relocation.status == RelocationStatus.Processed && operationMode === OperationMode.LockOrTransfer) {
                return relocation.amount;
              } else if (
                relocation.status == RelocationStatus.Pending
                || relocation.status == RelocationStatus.Postponed
                || (relocation.status == RelocationStatus.Aborted)
              ) {
                return relocation.amount + (relocation.fee || 0);
              }
            }
            return 0;
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

  async function prepareSingleRelocationRequesting(
    props: { isFeeTaken: boolean }
  ): Promise<{ relocation: TestTokenRelocation }> {
    const relocation: TestTokenRelocation = {
      chainId: CHAIN_ID,
      token: tokenMock1,
      account: user1,
      amount: 456,
      nonce: 1,
      status: RelocationStatus.Nonexistent,
      feeRefundMode: FeeRefundMode.Nothing
    };
    if (props.isFeeTaken) {
      await proveTx(multiTokenBridge.setFeeCollector(feeCollector.address));
      relocation.fee = Math.floor(relocation.amount / 10);
    }
    await setUpContractsForRelocations([relocation]);
    return { relocation };
  }

  async function prepareSingleRelocationExecution(
    props: { isFeeTaken: boolean }
  ): Promise<{ relocation: TestTokenRelocation }> {
    const { relocation } = await prepareSingleRelocationRequesting(props);
    await requestRelocations([relocation]);
    return { relocation };
  }

  async function prepareAccommodations(): Promise<{
    relocations: TestTokenRelocation[],
    accommodations: OnChainAccommodation[],
    firstNonce: number
  }> {
    const relocations: TestTokenRelocation[] = [1, 2, 3, 4].map(function (nonce: number): TestTokenRelocation {
      return {
        chainId: CHAIN_ID,
        token: (nonce <= 2) ? tokenMock1 : tokenMock2,
        account: (nonce % 2) === 1 ? user1 : user2,
        amount: nonce * 100,
        nonce: nonce,
        status: RelocationStatus.Processed
      };
    });
    const accommodations: OnChainAccommodation[] = relocations.map(toOnChainAccommodation);

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

    return { relocations, accommodations, firstNonce: relocations[0].nonce };
  }

  describe("Function 'initialize()'", async () => {
    it("Configures the contract as expected", async () => {
      await beforeEachConfigurationTest();

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

      // Fee related settings
      expect(await multiTokenBridge.feeOracle()).to.equal(ethers.constants.AddressZero);
      expect(await multiTokenBridge.feeCollector()).to.equal(ethers.constants.AddressZero);
      expect(await multiTokenBridge.isFeeTaken()).to.equal(false);

      // Guard related settings
      expect(await multiTokenBridge.guard()).to.equal(ethers.constants.AddressZero);
    });

    it("Is reverted if it is called a second time", async () => {
      await beforeEachConfigurationTest();
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
        await beforeEachConfigurationTest();
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

      it("Is reverted if the caller does not have the owner role", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.connect(user1).setRelocationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, OWNER_ROLE));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.setRelocationMode(
            CHAIN_ID,
            FAKE_TOKEN_ADDRESS,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE);
      });

      it("Is reverted if the call does not changed the relocation mode", async () => {
        await beforeEachConfigurationTest();
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
        await beforeEachConfigurationTest();
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
        await beforeEachConfigurationTest();
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

      it("Is reverted if the caller does not have the owner role", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.connect(user1).setAccommodationMode(
            CHAIN_ID,
            tokenMock1.address,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, OWNER_ROLE));
      });

      it("Is reverted if the new mode is BurnOrMint and the token does not support bridge operations", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.setAccommodationMode(
            CHAIN_ID,
            FAKE_TOKEN_ADDRESS,
            OperationMode.BurnOrMint
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_TOKEN_IS_NOT_BRIDGEABLE);
      });

      it("Is reverted if the call does not changed the accommodation mode", async () => {
        await beforeEachConfigurationTest();
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
        await beforeEachConfigurationTest();
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

    describe("Function 'setFeeOracle()'", async () => {
      it("Executes as expected and emits the correct events in different cases", async () => {
        await beforeEachConfigurationTest();

        await expect(
          multiTokenBridge.setFeeOracle(FAKE_FEE_ORACLE_ADDRESS)
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_FEE_ORACLE
        ).withArgs(
          ethers.constants.AddressZero,
          FAKE_FEE_ORACLE_ADDRESS
        );
        expect(await multiTokenBridge.feeOracle()).to.equal(FAKE_FEE_ORACLE_ADDRESS);

        await expect(
          multiTokenBridge.setFeeOracle(ethers.constants.AddressZero)
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_FEE_ORACLE
        ).withArgs(
          FAKE_FEE_ORACLE_ADDRESS,
          ethers.constants.AddressZero,
        );
        expect(await multiTokenBridge.feeOracle()).to.equal(ethers.constants.AddressZero);
      });

      it("Is reverted if the caller does not have the owner role", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.connect(user1).setFeeOracle(FAKE_FEE_ORACLE_ADDRESS)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, OWNER_ROLE));
      });

      it("Is reverted if the call does not changed the fee oracle address", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.setFeeOracle(ethers.constants.AddressZero)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_FEE_ORACLE_HAS_NOT_BEEN_CHANGED
        );
      });
    });

    describe("Function 'setFeeCollector()'", async () => {
      it("Executes as expected and emits the correct events in different cases", async () => {
        await beforeEachConfigurationTest();

        await expect(
          multiTokenBridge.setFeeCollector(FAKE_FEE_COLLECTOR_ADDRESS)
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_FEE_COLLECTOR
        ).withArgs(
          ethers.constants.AddressZero,
          FAKE_FEE_COLLECTOR_ADDRESS
        );
        expect(await multiTokenBridge.feeCollector()).to.equal(FAKE_FEE_COLLECTOR_ADDRESS);

        await expect(
          multiTokenBridge.setFeeCollector(ethers.constants.AddressZero)
        ).to.emit(
          multiTokenBridge,
          EVENT_NAME_SET_FEE_COLLECTOR
        ).withArgs(
          FAKE_FEE_COLLECTOR_ADDRESS,
          ethers.constants.AddressZero,
        );
        expect(await multiTokenBridge.feeCollector()).to.equal(ethers.constants.AddressZero);
      });

      it("Is reverted if the caller does not have the owner role", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.connect(user1).setFeeCollector(FAKE_FEE_COLLECTOR_ADDRESS)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, OWNER_ROLE));
      });

      it("Is reverted if the call does not changed the fee collector address", async () => {
        await beforeEachConfigurationTest();
        await expect(
          multiTokenBridge.setFeeCollector(ethers.constants.AddressZero)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_FEE_COLLECTOR_HAS_NOT_BEEN_CHANGED
        );
      });
    });
  });

  describe("Function 'setGuard()'", async () => {
    it("Executes as expected and emits the correct events in different cases", async () => {
      await beforeEachConfigurationTest();

      await expect(
        multiTokenBridge.setGuard(FAKE_GUARD_ADDRESS)
      ).to.emit(
        multiTokenBridge,
        EVENT_NAME_SET_GUARD
      ).withArgs(
        ethers.constants.AddressZero,
        FAKE_GUARD_ADDRESS
      );
      expect(await multiTokenBridge.guard()).to.equal(FAKE_GUARD_ADDRESS);

      await expect(
        multiTokenBridge.setGuard(ethers.constants.AddressZero)
      ).to.emit(
        multiTokenBridge,
        EVENT_NAME_SET_GUARD
      ).withArgs(
        FAKE_GUARD_ADDRESS,
        ethers.constants.AddressZero,
      );
      expect(await multiTokenBridge.guard()).to.equal(ethers.constants.AddressZero);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      await beforeEachConfigurationTest();
      await expect(
        multiTokenBridge.connect(user1).setGuard(FAKE_GUARD_ADDRESS)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, OWNER_ROLE));
    });

    it("Is reverted if the call does not changed the guard address", async () => {
      await beforeEachConfigurationTest();
      await expect(
        multiTokenBridge.setGuard(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(
        multiTokenBridge,
        REVERT_ERROR_IF_GUARD_HAS_NOT_BEEN_CHANGED
      );
    });
  });

  describe("Interactions related to relocations in the BurnOrMint operation mode", async () => {
    describe("Function 'requestRelocation()'", async () => {
      async function beforeRequestingRelocation(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationRequesting(props);
      }

      async function checkRequestingRelocation(relocation: TestTokenRelocation) {
        const totalAmount = relocation.amount + (relocation.fee || 0);
        await expect(
          multiTokenBridge.connect(relocation.account).requestRelocation(
            relocation.chainId,
            relocation.token.address,
            relocation.amount
          )
        ).to.changeTokenBalances(
          relocation.token,
          [multiTokenBridge, relocation.account, feeCollector],
          [+totalAmount, -totalAmount, 0]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_REQUEST_RELOCATION
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          relocation.fee || 0
        );
        relocation.requested = true;
        relocation.status = RelocationStatus.Pending;
        await checkBridgeState([relocation]);
      }

      describe("Transfers tokens as expected, emits the correct event, changes the state properly if", async () => {
        it("Fee is taken", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: true });
          expect(await multiTokenBridge.isFeeTaken()).to.equal(true);
          await checkRequestingRelocation(relocation);
        });

        it("No fee is taken", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: false });
          expect(await multiTokenBridge.isFeeTaken()).to.equal(false);
          await checkRequestingRelocation(relocation);
        });
      });

      describe("Is reverted if", async () => {
        it("The contract is paused", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: false });
          await pauseMultiTokenBridge();

          await expect(
            multiTokenBridge.connect(relocation.account).requestRelocation(
              relocation.chainId,
              relocation.token.address,
              relocation.amount
            )
          ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
        });

        it("The token address is zero", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: false });
          await expect(
            multiTokenBridge.connect(relocation.account).requestRelocation(
              relocation.chainId,
              ethers.constants.AddressZero,
              relocation.amount
            )
          ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_TOKEN_ADDRESS_IS_ZERO);
        });

        it("The token amount of the relocation is zero", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: false });
          await expect(
            multiTokenBridge.connect(relocation.account).requestRelocation(
              relocation.chainId,
              relocation.token.address,
              0
            )
          ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_AMOUNT_IS_ZERO);
        });

        it("The target chain is unsupported for relocations", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: false });
          await expect(
            multiTokenBridge.connect(relocation.account).requestRelocation(
              relocation.chainId + 1,
              relocation.token.address,
              relocation.amount
            )
          ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED);
        });

        it("The token is unsupported for relocations", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: false });
          await expect(
            multiTokenBridge.connect(relocation.account).requestRelocation(
              relocation.chainId,
              FAKE_TOKEN_ADDRESS,
              relocation.amount
            )
          ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_IS_UNSUPPORTED);
        });

        it("The user has not enough token balance for the relocation amount", async () => {
          const { relocation } = await beforeRequestingRelocation({ isFeeTaken: false });
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
    });

    describe("Function 'cancelRelocation()'", async () => {
      async function beforeCancelingRelocation(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationExecution(props);
      }

      async function checkCancelingRelocation(relocation: TestTokenRelocation) {
        const totalAmount = relocation.amount + (relocation.fee || 0);
        const collectedFee = (relocation.fee || 0) - (relocation.refundedFee || 0);
        const returnedAmount = relocation.amount + (relocation.refundedFee || 0);
        await expect(
          multiTokenBridge.connect(bridger).cancelRelocation(
            relocation.chainId,
            relocation.nonce,
            relocation.feeRefundMode
          )
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account, feeCollector],
          [-totalAmount, +returnedAmount, +collectedFee]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_CANCEL_RELOCATION
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          relocation.refundedFee || 0
        );
        relocation.fee = (relocation.fee || 0) - (relocation.refundedFee || 0);
        relocation.status = RelocationStatus.Canceled;
        await checkBridgeState([relocation]);
      }

      describe("Executes as expected and emits the correct event if the relocation status is", async () => {
        it("'Pending', and the fee was taken, and the fee refund mode is 'Full'", async () => {
          const { relocation } = await beforeCancelingRelocation({ isFeeTaken: true });
          relocation.feeRefundMode = FeeRefundMode.Full;
          relocation.refundedFee = relocation.fee;
          await checkCancelingRelocation(relocation);
        });

        it("'Postponed', and the fee was taken, and the fee refund mode is 'Full'", async () => {
          const { relocation } = await beforeCancelingRelocation({ isFeeTaken: true });
          await postponeRelocations([relocation]);
          relocation.feeRefundMode = FeeRefundMode.Full;
          relocation.refundedFee = relocation.fee;
          await checkCancelingRelocation(relocation);
        });

        it("'Pending', and the fee was taken, and the fee refund mode is 'Nothing'", async () => {
          const { relocation } = await beforeCancelingRelocation({ isFeeTaken: true });
          relocation.feeRefundMode = FeeRefundMode.Nothing;
          relocation.refundedFee = 0;
          await checkCancelingRelocation(relocation);
        });

        it("'Pending', and the fee was not taken, and the fee refund mode is 'Full'", async () => {
          const { relocation } = await beforeCancelingRelocation({ isFeeTaken: false });
          relocation.feeRefundMode = FeeRefundMode.Full;
          relocation.refundedFee = 0;
          await checkCancelingRelocation(relocation);
        });
      });

      describe("Is reverted if", async () => {
        it("The caller does not have the bridger role", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await expect(
            multiTokenBridge.connect(deployer).cancelRelocation(CHAIN_ID, 0, FeeRefundMode.Nothing)
          ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
        });

        it("The contract is paused", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await pauseMultiTokenBridge();

          await expect(
            multiTokenBridge.connect(bridger).cancelRelocation(CHAIN_ID, 0, FeeRefundMode.Nothing)
          ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
        });

        // Other tests for reverting with a single relocation see in a separate "Complex ..." section below
      });
    });

    describe("Function 'rejectRelocation()'", async () => {
      async function beforeRejectingRelocation(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationExecution(props);
      }

      async function checkRejectingRelocation(relocation: TestTokenRelocation) {
        const totalAmount = relocation.amount + (relocation.fee || 0);
        const collectedFee = (relocation.fee || 0) - (relocation.refundedFee || 0);
        const returnedAmount = relocation.amount + (relocation.refundedFee || 0);
        await expect(
          multiTokenBridge.connect(bridger).rejectRelocation(
            relocation.chainId,
            relocation.nonce,
            relocation.feeRefundMode
          )
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account, feeCollector],
          [-totalAmount, +returnedAmount, +collectedFee]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_REJECT_RELOCATION
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce,
          relocation.refundedFee || 0
        );
        relocation.status = RelocationStatus.Rejected;
        relocation.fee = (relocation.fee || 0) - (relocation.refundedFee || 0);
        await checkBridgeState([relocation]);
      }

      describe("Executes as expected and emits the correct event if the relocation status is", async () => {
        it("'Pending', and the fee was taken, and the fee refund mode is 'Full'", async () => {
          const { relocation } = await beforeRejectingRelocation({ isFeeTaken: true });
          relocation.feeRefundMode = FeeRefundMode.Full;
          relocation.refundedFee = relocation.fee;
          await checkRejectingRelocation(relocation);
        });

        it("'Postponed', and the fee was taken, and the fee refund mode is 'Full'", async () => {
          const { relocation } = await beforeRejectingRelocation({ isFeeTaken: true });
          await postponeRelocations([relocation]);
          relocation.feeRefundMode = FeeRefundMode.Full;
          relocation.refundedFee = relocation.fee;
          await checkRejectingRelocation(relocation);
        });

        it("'Pending', and the fee was taken, and the fee refund mode is 'Nothing'", async () => {
          const { relocation } = await beforeRejectingRelocation({ isFeeTaken: true });
          relocation.feeRefundMode = FeeRefundMode.Nothing;
          relocation.refundedFee = 0;
          await checkRejectingRelocation(relocation);
        });

        it("'Pending', and the fee was not taken, and the fee refund mode is 'Full'", async () => {
          const { relocation } = await beforeRejectingRelocation({ isFeeTaken: false });
          relocation.feeRefundMode = FeeRefundMode.Full;
          relocation.refundedFee = 0;
          await checkRejectingRelocation(relocation);
        });
      });

      describe("Is reverted if", async () => {
        it("The caller does not have the bridger role", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await expect(
            multiTokenBridge.connect(deployer).rejectRelocation(CHAIN_ID, 0, FeeRefundMode.Nothing)
          ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
        });

        it("The contract is paused", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await pauseMultiTokenBridge();

          await expect(
            multiTokenBridge.connect(bridger).rejectRelocation(CHAIN_ID, 0, FeeRefundMode.Nothing)
          ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
        });

        // Other tests for reverting with a single relocation see in a separate "Complex ..." section below
      });
    });

    describe("Function 'abortRelocation()'", async () => {
      async function beforeAbortingRelocation(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationExecution(props);
      }

      async function checkAbortingRelocation(relocation: TestTokenRelocation) {
        await checkBridgeState([relocation]);
        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account, feeCollector],
          [0, 0, 0]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_ABORT_RELOCATION
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce
        );
        relocation.status = RelocationStatus.Aborted;
        await checkBridgeState([relocation]);
      }

      describe("Executes as expected and emits the correct event if the relocation status is", async () => {
        it("'Pending', and the fee was taken", async () => {
          const { relocation } = await beforeAbortingRelocation({ isFeeTaken: true });
          await checkAbortingRelocation(relocation);
        });

        it("'Postponed', and the fee was taken", async () => {
          const { relocation } = await beforeAbortingRelocation({ isFeeTaken: true });
          await postponeRelocations([relocation]);
          await checkAbortingRelocation(relocation);
        });

        it("'Pending', and the fee was not taken", async () => {
          const { relocation } = await beforeAbortingRelocation({ isFeeTaken: false });
          await checkAbortingRelocation(relocation);
        });
      });

      describe("Is reverted if", async () => {
        it("The caller does not have the bridger role", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await expect(
            multiTokenBridge.connect(deployer).abortRelocation(CHAIN_ID, 0)
          ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
        });

        it("The contract is paused", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await pauseMultiTokenBridge();

          await expect(
            multiTokenBridge.connect(bridger).abortRelocation(CHAIN_ID, 0)
          ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
        });

        // Other tests for reverting with a single relocation see in a separate "Complex ..." section below
      });
    });

    describe("Function 'postponeRelocation()'", async () => {
      async function beforePostponingRelocation(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationExecution(props);
      }

      async function checkPostponingRelocation(relocation: TestTokenRelocation) {
        await expect(
          multiTokenBridge.connect(bridger).postponeRelocation(relocation.chainId, relocation.nonce)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, relocation.account],
          [0, 0]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_POSTPONE_RELOCATION
        ).withArgs(
          relocation.chainId,
          relocation.token.address,
          relocation.account.address,
          relocation.amount,
          relocation.nonce
        );
        relocation.status = RelocationStatus.Postponed;
        await checkBridgeState([relocation]);
      }

      describe("Executes as expected and emits the correct event if the relocation is pending and", async () => {
        it("The fee was taken", async () => {
          const { relocation } = await beforePostponingRelocation({ isFeeTaken: true });
          await checkPostponingRelocation(relocation);
        });

        it("The fee was not taken", async () => {
          const { relocation } = await beforePostponingRelocation({ isFeeTaken: false });
          await checkPostponingRelocation(relocation);
        });
      });

      describe("Is reverted if", async () => {
        it("The caller does not have the bridger role", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await expect(
            multiTokenBridge.connect(deployer).postponeRelocation(CHAIN_ID, 0)
          ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
        });

        it("The contract is paused", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await pauseMultiTokenBridge();

          await expect(
            multiTokenBridge.connect(bridger).postponeRelocation(CHAIN_ID, 0)
          ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
        });

        // Other tests for reverting with a single relocation see in a separate "Complex ..." section below
      });
    });

    describe("Function 'continueRelocation()'", async () => {
      async function beforeContinuingRelocation(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        const { relocation } = await prepareSingleRelocationExecution(props);
        await postponeRelocations([relocation]);
        return { relocation };
      }

      async function checkContinuingRelocation(oldRelocation: TestTokenRelocation) {
        await expect(
          multiTokenBridge.connect(bridger).continueRelocation(oldRelocation.chainId, oldRelocation.nonce)
        ).to.changeTokenBalances(
          oldRelocation.token,
          [multiTokenBridge, oldRelocation.account],
          [0, 0]
        ).and.to.emit(
          multiTokenBridge,
          EVENT_NAME_CONTINUE_RELOCATION
        ).withArgs(
          oldRelocation.chainId,
          oldRelocation.token.address,
          oldRelocation.account.address,
          oldRelocation.amount,
          oldRelocation.nonce,
          oldRelocation.nonce + 1
        );
        oldRelocation.status = RelocationStatus.Continued;
        const newRelocation: TestTokenRelocation = treatRelocationAsLastOneBeforeContinuing(oldRelocation);
        await checkBridgeState([oldRelocation, newRelocation]);
      }

      describe("Executes as expected and emits the correct event if", async () => {
        it("The fee was taken", async () => {
          const { relocation } = await beforeContinuingRelocation({ isFeeTaken: true });
          await checkContinuingRelocation(relocation);
        });

        it("The fee was not taken", async () => {
          const { relocation } = await beforeContinuingRelocation({ isFeeTaken: false });
          await checkContinuingRelocation(relocation);
        });
      });

      describe("Is reverted if", async () => {
        it("Is reverted if the caller does not have the bridger role", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await expect(
            multiTokenBridge.connect(deployer).continueRelocation(CHAIN_ID, 0)
          ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
        });

        it("Is reverted if the contract is paused", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await pauseMultiTokenBridge();

          await expect(
            multiTokenBridge.connect(bridger).continueRelocation(CHAIN_ID, 0)
          ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
        });

        // Other tests for reverting with a single relocation see in a separate "Complex ..." section below
      });
    });

    describe("Function 'relocate()'", async () => {
      const relocationCount = 1;

      async function beforeExecutionOfRelocate(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        return prepareSingleRelocationExecution(props);
      }

      async function checkExecutionIfRelocationIsPending(relocation: TestTokenRelocation) {
        const totalAmount = relocation.amount + (relocation.fee || 0);
        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, user1, user2, feeCollector],
          [-totalAmount, 0, 0, +(relocation.fee || 0)]
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
      }

      async function checkExecutionIfRelocationIsNotPending(relocations: TestTokenRelocation[]) {
        await checkBridgeState(relocations);
        const balanceBefore: BigNumber = await tokenMock1.balanceOf(multiTokenBridge.address);

        await expect(
          multiTokenBridge.connect(bridger).relocate(relocations[0].chainId, relocationCount)
        ).and.not.to.emit(
          multiTokenBridge,
          EVENT_NAME_RELOCATE
        );

        const balanceAfter: BigNumber = await tokenMock1.balanceOf(multiTokenBridge.address);
        expect(balanceAfter.sub(balanceBefore)).to.equal(0);
        markRelocationsAsProcessed([relocations[0]]);
        await checkBridgeState(relocations);
      }

      describe("Executes as expected and emits the correct event if the relocation is pending and", async () => {
        it("The fee was taken", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: true });
          await checkExecutionIfRelocationIsPending(relocation);
        });

        it("The fee was not taken", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await checkExecutionIfRelocationIsPending(relocation);
        });
      });

      describe("Burns no tokens, emits no events if the relocation status is", async () => {
        it("'Canceled'", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await cancelRelocations([relocation]);
          await checkExecutionIfRelocationIsNotPending([relocation]);
        });

        it("'Rejected'", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await rejectRelocations([relocation]);
          await checkExecutionIfRelocationIsNotPending([relocation]);
        });

        it("'Aborted'", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await abortRelocations([relocation]);
          await checkExecutionIfRelocationIsNotPending([relocation]);
        });

        it("'Postponed'", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await postponeRelocations([relocation]);
          await checkExecutionIfRelocationIsNotPending([relocation]);
        });

        it("'Continued'", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await postponeRelocations([relocation]);
          await continueRelocations([relocation]);
          const newRelocation = treatRelocationAsLastOneBeforeContinuing(relocation);
          await checkExecutionIfRelocationIsNotPending([relocation, newRelocation]);
        });
      });

      describe("Is reverted if", async () => {
        it("The contract is paused", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await pauseMultiTokenBridge();

          await expect(
            multiTokenBridge.connect(bridger).relocate(CHAIN_ID, relocationCount)
          ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
        });

        it("The caller does not have the bridger role", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          await expect(
            multiTokenBridge.connect(deployer).relocate(CHAIN_ID, relocationCount)
          ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
        });

        it("The relocation count is zero", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await expect(
            multiTokenBridge.connect(bridger).relocate(relocation.chainId, 0)
          ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_RELOCATION_COUNT_IS_ZERO);
        });

        it("The relocation count exceeds the number of pending relocations", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await expect(
            multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount + 1)
          ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_LACK_OF_PENDING_RELOCATIONS);
        });

        it("Burning of tokens fails", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await proveTx(tokenMock1.disableBurningForBridging());

          await expect(
            multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount)
          ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_BURNING_OF_TOKENS_FAILED);
        });
      });
    });

    describe("Complex scenario with a single relocation", async () => {
      async function checkAllRelocationStatusChangingFunctionsFailure(relocation: TestTokenRelocation) {
        await expect(
          multiTokenBridge.connect(bridger).cancelRelocation(
            relocation.chainId,
            relocation.nonce,
            relocation.feeRefundMode
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          relocation.status
        );

        await expect(
          multiTokenBridge.connect(bridger).rejectRelocation(
            relocation.chainId,
            relocation.nonce,
            relocation.feeRefundMode
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          relocation.status
        );

        await expect(
          multiTokenBridge.connect(bridger).abortRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          relocation.status
        );

        await expect(
          multiTokenBridge.connect(bridger).postponeRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          relocation.status
        );

        if (relocation.status === RelocationStatus.Postponed) {
          return;
        }

        await expect(
          multiTokenBridge.connect(bridger).continueRelocation(relocation.chainId, relocation.nonce)
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(
          relocation.status
        );
      }

      describe("All status changing functions fail if a relocation with the provided nonce", async () => {
        it("Does not exist", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          const { relocation } = await prepareSingleRelocationRequesting({ isFeeTaken: false });
          await checkAllRelocationStatusChangingFunctionsFailure(relocation);
        });

        it("Is already processed", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          const { relocation } = await prepareSingleRelocationExecution({ isFeeTaken: false });
          await proveTx(multiTokenBridge.connect(bridger).relocate(relocation.chainId, 1));
          relocation.status = RelocationStatus.Processed;
          await checkAllRelocationStatusChangingFunctionsFailure(relocation);
        });

        it("Is canceled", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          const { relocation } = await prepareSingleRelocationExecution({ isFeeTaken: false });
          await cancelRelocations([relocation]);
          await checkAllRelocationStatusChangingFunctionsFailure(relocation);
        });

        it("Is rejected", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          const { relocation } = await prepareSingleRelocationExecution({ isFeeTaken: false });
          await rejectRelocations([relocation]);
          await checkAllRelocationStatusChangingFunctionsFailure(relocation);
        });

        it("Is aborted", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          const { relocation } = await prepareSingleRelocationExecution({ isFeeTaken: false });
          await abortRelocations([relocation]);
          await checkAllRelocationStatusChangingFunctionsFailure(relocation);
        });

        it("Is continued", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          const { relocation } = await prepareSingleRelocationExecution({ isFeeTaken: false });
          await postponeRelocations([relocation]);
          await continueRelocations([relocation]);
          await checkAllRelocationStatusChangingFunctionsFailure(relocation);
        });
      });

      describe("Several postponements and continuations", async () => {
        it("Are executed as expected", async () => {
          await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
          const { relocation } = await prepareSingleRelocationExecution({ isFeeTaken: false });

          await postponeRelocations([relocation]);
          await checkBridgeState([relocation]);

          await continueRelocations([relocation]);
          const newRelocation: TestTokenRelocation = treatRelocationAsLastOneBeforeContinuing(relocation);
          await checkBridgeState([relocation, newRelocation]);

          await postponeRelocations([newRelocation]);
          await checkBridgeState([relocation, newRelocation]);

          await continueRelocations([newRelocation]);
          const newRelocation2: TestTokenRelocation = treatRelocationAsLastOneBeforeContinuing(newRelocation);
          await checkBridgeState([relocation, newRelocation, newRelocation2]);
        });
      });
    });

    describe("Complex scenario for a single chain with several tokens", async () => {
      async function beforeComplexScenarioForSingleChain(): Promise<{ relocations: TestTokenRelocation[] }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
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
          multiTokenBridge.connect(bridger).cancelRelocation(
            relocations[0].chainId,
            relocations[0].nonce,
            relocations[0].feeRefundMode || FeeRefundMode.Nothing
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge, REVERT_ERROR_IF_RELOCATION_HAS_INAPPROPRIATE_STATUS
        ).withArgs(RelocationStatus.Processed);

        // Check that state of the bridge has not changed
        await checkBridgeState(relocations);

        // Request another relocation
        await requestRelocations([relocations[3]]);
        await checkBridgeState(relocations);

        // Cancel two last relocations
        await cancelRelocations([relocations[3], relocations[2]]);
        await checkBridgeState(relocations);

        // Process all the pending relocations
        await proveTx(multiTokenBridge.connect(bridger).relocate(CHAIN_ID, 3));
        markRelocationsAsProcessed(relocations);
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
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
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

        // Cancel some relocations by users
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
    describe("Function 'relocate()'", async () => {
      const relocationCount = 1;

      async function beforeExecutionOfRelocate(
        props: { isFeeTaken: boolean }
      ): Promise<{ relocation: TestTokenRelocation }> {
        await beforeEachNonConfigurationTest(OperationMode.LockOrTransfer);
        return prepareSingleRelocationExecution(props);
      }

      async function checkExecutionIfRelocationIsPending(relocation: TestTokenRelocation) {
        await expect(
          multiTokenBridge.connect(bridger).relocate(relocation.chainId, relocationCount)
        ).to.changeTokenBalances(
          tokenMock1,
          [multiTokenBridge, user1, user2, feeCollector],
          [-(relocation.fee || 0), 0, 0, +(relocation.fee || 0)]
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
      }

      describe("Executes as expected and emits the correct event if the relocation is pending and", async () => {
        it("The fee was taken", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: true });
          await checkExecutionIfRelocationIsPending(relocation);
        });

        it("The fee was not taken", async () => {
          const { relocation } = await beforeExecutionOfRelocate({ isFeeTaken: false });
          await checkExecutionIfRelocationIsPending(relocation);
        });
      });
    });
  });

  describe("Interactions related to accommodations in the BurnOrMint operation mode", async () => {
    describe("Function 'accommodate()'", async () => {
      async function beforeExecutionOfAccommodate(): Promise<{
        relocations: TestTokenRelocation[],
        accommodations: OnChainAccommodation[],
        firstNonce: number
      }> {
        await beforeEachNonConfigurationTest(OperationMode.BurnOrMint);
        return prepareAccommodations();
      }

      it("Mints tokens as expected, emits the correct events, changes the state properly", async () => {
        const { relocations, accommodations, firstNonce } = await beforeExecutionOfAccommodate();

        const tx: TransactionResponse = await multiTokenBridge.connect(bridger).accommodate(
          CHAIN_ID,
          firstNonce,
          accommodations
        );
        await checkAccommodationEvents(tx, relocations);
        await checkAccommodationTokenTransfers(tx, relocations, tokenMock1);
        await checkAccommodationTokenTransfers(tx, relocations, tokenMock2);
        expect(
          await multiTokenBridge.getLastAccommodationNonce(CHAIN_ID)
        ).to.equal(relocations[relocations.length - 1].nonce);
      });

      it("Does not mint tokens and emit events if the accommodation status is not `Processed`", async () => {
        const { relocations, accommodations: [accommodation], firstNonce } = await beforeExecutionOfAccommodate();
        const { token, account, amount } = accommodation;
        const accommodations: OnChainAccommodation[] = [
          { token, account, amount, status: RelocationStatus.Canceled },
          { token, account, amount, status: RelocationStatus.Rejected },
          { token, account, amount, status: RelocationStatus.Aborted },
          { token, account, amount, status: RelocationStatus.Pending },
          { token, account, amount, status: RelocationStatus.Continued }
        ];

        const tx: TransactionResponse = await multiTokenBridge.connect(bridger).accommodate(
          CHAIN_ID,
          firstNonce,
          accommodations
        );
        await expect(tx).to.changeTokenBalances(
          relocations[0].token,
          [multiTokenBridge, relocations[0].account],
          [0, 0]
        );
        await expect(tx).not.to.emit(
          multiTokenBridge,
          EVENT_NAME_ACCOMMODATE
        );
      });

      it("Is reverted if the contract is paused", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        await pauseMultiTokenBridge();

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("Is reverted if the caller does not have the bridger role", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(deployer).accommodate(
            CHAIN_ID,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BRIDGER_ROLE));
      });

      it("Is reverted if the chain is unsupported for accommodations", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID + 1,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED);
      });

      it("Is reverted if one of the token contracts is unsupported for accommodations", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        accommodations[1].token = FAKE_TOKEN_ADDRESS;

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_IS_UNSUPPORTED);
      });

      it("Is reverted if the first relocation nonce is zero", async () => {
        const { accommodations } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            0,
            accommodations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_NONCE_IS_ZERO);
      });

      it("Is reverted if the first relocation nonce does not equal the last accommodation nonce +1", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce + 1,
            accommodations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_NONCE_MISMATCH);
      });

      it("Is reverted if the input array of relocations is empty", async () => {
        const { firstNonce } = await beforeExecutionOfAccommodate();
        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce,
            []
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_ARRAY_OF_RELOCATIONS_IS_EMPTY);
      });

      it("Is reverted if one of the input accounts has zero address", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        accommodations[1].account = ethers.constants.AddressZero;

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_ACCOUNT_IS_ZERO_ADDRESS);
      });

      it("Is reverted if one of the input amounts is zero", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        accommodations[1].amount = ethers.constants.Zero;

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_ACCOMMODATION_AMOUNT_IS_ZERO);
      });

      it("Is reverted if minting of tokens had failed", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        await proveTx(tokenMock1.disableMintingForBridging());

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWithCustomError(multiTokenBridge, REVERT_ERROR_IF_MINTING_OF_TOKENS_FAILED);
      });

      it("Is reverted if the guard contract returns a non-zero error code", async () => {
        const { accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        const callCounterLimit = accommodations.length - 1;
        const errorCode = 12345;
        await proveTx(guardMock.configure(callCounterLimit, errorCode));
        await proveTx(multiTokenBridge.setGuard(guardMock.address));

        await expect(
          multiTokenBridge.connect(bridger).accommodate(
            CHAIN_ID,
            firstNonce,
            accommodations
          )
        ).to.be.revertedWithCustomError(
          multiTokenBridge,
          REVERT_ERROR_IF_ACCOMMODATION_GUARD_BAN
        ).withArgs(
          callCounterLimit,
          errorCode
        );
      });
    });
  });

  describe("Interactions related to accommodations in the LockOrTransfer operation mode", async () => {
    describe("Function 'accommodate()'", async () => {
      async function beforeExecutionOfAccommodate(): Promise<{
        relocations: TestTokenRelocation[],
        accommodations: OnChainAccommodation[],
        firstNonce: number
      }> {
        await beforeEachNonConfigurationTest(OperationMode.LockOrTransfer);
        return prepareAccommodations();
      }

      it("Transfers tokens as expected, emits the correct events, changes the state properly", async () => {
        const { relocations, accommodations, firstNonce } = await beforeExecutionOfAccommodate();
        await proveTx(tokenMock1.mint(multiTokenBridge.address, ethers.constants.MaxUint256));
        await proveTx(tokenMock2.mint(multiTokenBridge.address, ethers.constants.MaxUint256));

        const tx: TransactionResponse = multiTokenBridge.connect(bridger).accommodate(
          CHAIN_ID,
          firstNonce,
          accommodations
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
