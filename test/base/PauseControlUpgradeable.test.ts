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

describe("Contract 'PauseControlUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  let pauseControlMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let pauser: SignerWithAddress;

  let ownerRole: string;
  let pauserRole: string;

  before(async () => {
    pauseControlMockFactory = await ethers.getContractFactory("PauseControlUpgradeableMock");
    [deployer, pauser] = await ethers.getSigners();
    ownerRole = ethers.utils.id("OWNER_ROLE");
    pauserRole = ethers.utils.id("PAUSER_ROLE");
  });

  async function deployPauseControlMock(): Promise<{ pauseControlMock: Contract }> {
    const pauseControlMock: Contract = await upgrades.deployProxy(pauseControlMockFactory);
    await pauseControlMock.deployed();
    return { pauseControlMock };
  }

  async function deployAndConfigurePauseControlMock(): Promise<{ pauseControlMock: Contract }> {
    const { pauseControlMock } = await deployPauseControlMock();
    await proveTx(pauseControlMock.grantRole(pauserRole, pauser.address));
    return { pauseControlMock };
  }

  describe("Function 'initialize()'", async () => {
    it("The external initializer configures the contract as expected", async () => {
      const { pauseControlMock } = await setUpFixture(deployPauseControlMock);

      //The roles
      expect((await pauseControlMock.OWNER_ROLE()).toLowerCase()).to.equal(ownerRole);
      expect((await pauseControlMock.PAUSER_ROLE()).toLowerCase()).to.equal(pauserRole);

      // The role admins
      expect(await pauseControlMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
      expect(await pauseControlMock.getRoleAdmin(pauserRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await pauseControlMock.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await pauseControlMock.hasRole(pauserRole, deployer.address)).to.equal(false);

      // The initial contract state is unpaused
      expect(await pauseControlMock.paused()).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { pauseControlMock } = await setUpFixture(deployPauseControlMock);
      await expect(
        pauseControlMock.initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { pauseControlMock } = await setUpFixture(deployPauseControlMock);
      await expect(
        pauseControlMock.call_parent_initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { pauseControlMock } = await setUpFixture(deployPauseControlMock);
      await expect(
        pauseControlMock.call_parent_initialize_unchained()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });
  });

  describe("Function 'pause()'", async () => {
    it("Executes successfully and emits the correct event", async () => {
      const { pauseControlMock } = await setUpFixture(deployAndConfigurePauseControlMock);

      await expect(
        pauseControlMock.connect(pauser).pause()
      ).to.emit(
        pauseControlMock,
        "Paused"
      ).withArgs(pauser.address);

      expect(await pauseControlMock.paused()).to.equal(true);
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      const { pauseControlMock } = await setUpFixture(deployAndConfigurePauseControlMock);
      await expect(
        pauseControlMock.pause()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });
  });

  describe("Function 'unpause()'", async () => {
    it("Executes successfully and emits the correct event", async () => {
      const { pauseControlMock } = await setUpFixture(deployAndConfigurePauseControlMock);
      await proveTx(pauseControlMock.connect(pauser).pause());

      await expect(
        pauseControlMock.connect(pauser).unpause()
      ).to.emit(
        pauseControlMock,
        "Unpaused"
      ).withArgs(pauser.address);

      expect(await pauseControlMock.paused()).to.equal(false);
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      const { pauseControlMock } = await setUpFixture(deployAndConfigurePauseControlMock);
      await expect(
        pauseControlMock.unpause()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });
  });
});
