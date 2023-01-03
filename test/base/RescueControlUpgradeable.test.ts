import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

async function setUpFixture(func: any) {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'RescueControlUpgradeable'", async () => {
  const TOKEN_AMOUNT = 123;

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  let rescueControlMockFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let rescuer: SignerWithAddress;

  let ownerRole: string;
  let rescuerRole: string;

  before(async () => {
    rescueControlMockFactory = await ethers.getContractFactory("RescueControlUpgradeableMock");
    tokenMockFactory = await ethers.getContractFactory("ERC20UpgradeableMock");

    [deployer, rescuer] = await ethers.getSigners();
    ownerRole = ethers.utils.id("OWNER_ROLE");
    rescuerRole = ethers.utils.id("RESCUER_ROLE");
  });

  async function deployRescueControlMock(): Promise<{ rescueControlMock: Contract }> {
    const rescueControlMock: Contract = await upgrades.deployProxy(rescueControlMockFactory);
    await rescueControlMock.deployed();
    return { rescueControlMock };
  }

  async function deployTokenMock(): Promise<{ tokenMock: Contract }> {
    const tokenMock: Contract = await upgrades.deployProxy(tokenMockFactory, ["ERC20 Test", "TEST"]);
    await tokenMock.deployed();
    return { tokenMock };
  }

  async function deployAndConfigureAllContracts(): Promise<{ rescueControlMock: Contract, tokenMock: Contract }> {
    const { rescueControlMock } = await deployRescueControlMock();
    const { tokenMock } = await deployTokenMock();

    await proveTx(tokenMock.mint(rescueControlMock.address, TOKEN_AMOUNT));
    await proveTx(rescueControlMock.grantRole(rescuerRole, rescuer.address));

    return {
      rescueControlMock,
      tokenMock
    };
  }

  describe("Function 'initialize()'", async () => {
    it("The external initializer configures the contract as expected", async () => {
      const { rescueControlMock } = await setUpFixture(deployRescueControlMock);

      //The roles
      expect((await rescueControlMock.OWNER_ROLE()).toLowerCase()).to.equal(ownerRole);
      expect((await rescueControlMock.RESCUER_ROLE()).toLowerCase()).to.equal(rescuerRole);

      // The role admins
      expect(await rescueControlMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
      expect(await rescueControlMock.getRoleAdmin(rescuerRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await rescueControlMock.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await rescueControlMock.hasRole(rescuerRole, deployer.address)).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { rescueControlMock } = await setUpFixture(deployRescueControlMock);
      await expect(
        rescueControlMock.initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { rescueControlMock } = await setUpFixture(deployRescueControlMock);
      await expect(
        rescueControlMock.call_parent_initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { rescueControlMock } = await setUpFixture(deployRescueControlMock);
      await expect(
        rescueControlMock.call_parent_initialize_unchained()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });
  });

  describe("Function 'rescueERC20()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { rescueControlMock, tokenMock } = await setUpFixture(deployAndConfigureAllContracts);

      await expect(
        rescueControlMock.connect(rescuer).rescueERC20(
          tokenMock.address,
          deployer.address,
          TOKEN_AMOUNT
        )
      ).to.changeTokenBalances(
        tokenMock,
        [rescueControlMock, deployer, rescuer],
        [-TOKEN_AMOUNT, +TOKEN_AMOUNT, 0]
      ).and.to.emit(
        tokenMock,
        "Transfer"
      ).withArgs(
        rescueControlMock.address,
        deployer.address,
        TOKEN_AMOUNT
      );
    });

    it("Is reverted if is called by an account without the rescuer role", async () => {
      const { rescueControlMock, tokenMock } = await setUpFixture(deployAndConfigureAllContracts);
      await expect(
        rescueControlMock.rescueERC20(
          tokenMock.address,
          deployer.address,
          TOKEN_AMOUNT
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, rescuerRole));
    });
  });
});
