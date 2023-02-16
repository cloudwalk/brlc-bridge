import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../test-utils/eth";

enum ValidationStatus {
  NO_ERROR = 0,
  TIME_FRAME_NOT_SET = 1,
  VOLUME_LIMIT_REACHED = 2,
}

async function setUpFixture(func: any) {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

async function wait(timeoutInSeconds: number) {
  if (network.name === "hardhat") {
    // A virtual wait through network time shifting
    await time.increase(timeoutInSeconds);
  } else {
    // A real wait through a promise
    const timeoutInMills = timeoutInSeconds * 1000;
    await new Promise((resolve) => setTimeout(resolve, timeoutInMills));
  }
}

describe("Contract 'BridgeGuard'", () => {
  const TEN_SECONDS = 10;
  const ONE_THOUSAND = 1000;
  const TWO_THOUSANDS = 2000;
  const FIRST_CHAIN = 1;

  const ZERO_ADDRESS = ethers.constants.AddressZero;
  const TOKEN_ADDRESS = "0x0000000000000000000000000000000000000001";
  const INIT_BRIDGE_ADDRESS = "0x0000000000000000000000000000000000000002";

  const EVENT_NAME_MAX_RESET_ACCOMMODATION_GUARD = "ResetAccommodationGuard";
  const EVENT_NAME_ACCOMMODATION_GUARD_CONFIGURED =
    "ConfigureAccommodationGuard";

  const REVERT_ERROR_CALLER_NOT_BRIDGE = "NotBridge";
  const REVERT_ERROR_CALLER_NOT_OWNER = "Ownable: caller is not the owner";
  const REVERT_ERROR_CONTRACT_INITIALIZED =
    "Initializable: contract is already initialized";
  const REVERT_ERROR_ZERO_BRIDGE_ADDRESS = "ZeroBridgeAddress";
  const REVERT_ERROR_ZERO_CHAIN_ID = "ZeroChainId";
  const REVERT_ERROR_ZERO_TOKEN_ADDRESS = "ZeroTokenAddress";
  const REVERT_ERROR_ZERO_TIME_FRAME = "ZeroTimeFrame";
  const REVERT_ERROR_ZERO_VOLUME_LIMIT = "ZeroVolumeLimit";

  let bridgeGuardFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let bridge: SignerWithAddress;
  let user: SignerWithAddress;

  before(async () => {
    [deployer, bridge, user] = await ethers.getSigners();
    bridgeGuardFactory = await ethers.getContractFactory("BridgeGuard");
  });

  async function deployBridgeGuard(): Promise<{ guard: Contract }> {
    const guard = await upgrades.deployProxy(bridgeGuardFactory, [
      INIT_BRIDGE_ADDRESS,
    ]);
    await guard.deployed();
    return {
      guard,
    };
  }

  describe("Function 'initialize()'", () => {
    it("Configures contract as expected", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      expect(await guard.owner()).to.eq(deployer.address);
      expect(await guard.bridge()).to.eq(INIT_BRIDGE_ADDRESS);
    });

    it("Is reverted if called second time", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(guard.initialize(INIT_BRIDGE_ADDRESS)).to.be.revertedWith(
        REVERT_ERROR_CONTRACT_INITIALIZED
      );
    });

    it("Is reverted if the zero address is passed in constructor", async () => {
      const uninitializedGuard = await upgrades.deployProxy(
        bridgeGuardFactory,
        [ZERO_ADDRESS],
        { initializer: false }
      );

      await expect(
        uninitializedGuard.initialize(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(
        uninitializedGuard,
        REVERT_ERROR_ZERO_BRIDGE_ADDRESS
      );
    });
  });

  describe("Function 'setBridge()'", () => {
    it("Sets the new bridge", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      expect(await guard.bridge()).to.eq(INIT_BRIDGE_ADDRESS);
      await proveTx(guard.setBridge(bridge.address));
      expect(await guard.bridge()).to.eq(bridge.address);
    });

    it("Is reverted if the caller is not an owner", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.connect(user).setBridge(user.address)
      ).to.be.revertedWith(REVERT_ERROR_CALLER_NOT_OWNER);
    });

    it("Is reverted if the zero address is passed as the parameter", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(guard.setBridge(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        guard,
        REVERT_ERROR_ZERO_BRIDGE_ADDRESS
      );
    });
  });

  describe("Function 'configureAccommodationGuard()'", async () => {
    it("Creates the new bridge configuration and emits the correct event", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        await guard.configureAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TEN_SECONDS,
          ONE_THOUSAND
        )
      )
        .to.emit(guard, EVENT_NAME_ACCOMMODATION_GUARD_CONFIGURED)
        .withArgs(FIRST_CHAIN, TOKEN_ADDRESS, TEN_SECONDS, ONE_THOUSAND);

      const createdConfig = await guard.getAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS
      );

      const timeStamp = (await ethers.provider.getBlock("latest")).timestamp;

      expect(createdConfig.timeFrame).to.eq(TEN_SECONDS);
      expect(createdConfig.lastResetTime).to.eq(timeStamp);
      expect(createdConfig.currentVolume).to.eq(0);
      expect(createdConfig.volumeLimit).to.eq(ONE_THOUSAND);
    });

    it("Makes changes to the already created configuration", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await guard.configureAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS,
        TEN_SECONDS,
        ONE_THOUSAND
      );
      const createdConfig = await guard.getAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS
      );

      expect(createdConfig.volumeLimit).to.eq(ONE_THOUSAND);

      await guard.configureAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS,
        TEN_SECONDS,
        TWO_THOUSANDS
      );

      const updatedConfig = await guard.getAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS
      );

      expect(updatedConfig.volumeLimit).to.eq(TWO_THOUSANDS);
    });

    it("Is reverted if the caller is not an owner", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard
          .connect(user)
          .configureAccommodationGuard(
            FIRST_CHAIN,
            TOKEN_ADDRESS,
            TEN_SECONDS,
            ONE_THOUSAND
          )
      ).to.be.rejectedWith(REVERT_ERROR_CALLER_NOT_OWNER);
    });

    it("Is reverted if the zero chain id is passed", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.configureAccommodationGuard(
          0,
          TOKEN_ADDRESS,
          TEN_SECONDS,
          ONE_THOUSAND
        )
      ).to.be.revertedWithCustomError(guard, REVERT_ERROR_ZERO_CHAIN_ID);
    });

    it("Is reverted if the zero token address is passed", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.configureAccommodationGuard(
          FIRST_CHAIN,
          ZERO_ADDRESS,
          TEN_SECONDS,
          ONE_THOUSAND
        )
      ).to.be.revertedWithCustomError(guard, REVERT_ERROR_ZERO_TOKEN_ADDRESS);
    });

    it("Is reverted if the zero time frame is passed", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.configureAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          0,
          ONE_THOUSAND
        )
      ).to.be.revertedWithCustomError(guard, REVERT_ERROR_ZERO_TIME_FRAME);
    });

    it("Is reverted ifthe zero volume limit is passed", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.configureAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TEN_SECONDS,
          0
        )
      ).to.be.revertedWithCustomError(guard, REVERT_ERROR_ZERO_VOLUME_LIMIT);
    });
  });

  describe("Function 'resetAccommodationGuard()'", async () => {
    it("Resets a configured guard and emits the correct event", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await guard.configureAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS,
        TEN_SECONDS,
        ONE_THOUSAND
      );
      const configuredGuard = await guard.getAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS
      );

      expect(configuredGuard.volumeLimit).to.eq(ONE_THOUSAND);

      await expect(guard.resetAccommodationGuard(FIRST_CHAIN, TOKEN_ADDRESS))
        .to.emit(guard, EVENT_NAME_MAX_RESET_ACCOMMODATION_GUARD)
        .withArgs(FIRST_CHAIN, TOKEN_ADDRESS);

      const clearedGuard = await guard.getAccommodationGuard(
        FIRST_CHAIN,
        TOKEN_ADDRESS
      );

      expect(clearedGuard.volumeLimit).to.eq(0);
      expect(clearedGuard.timeFrame).to.eq(0);
      expect(clearedGuard.currentVolume).to.eq(0);
      expect(clearedGuard.lastResetTime).to.eq(0);
    });

    it("Is reverted if the caller is not an owner", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.connect(user).resetAccommodationGuard(FIRST_CHAIN, TOKEN_ADDRESS)
      ).to.be.revertedWith(REVERT_ERROR_CALLER_NOT_OWNER);
    });

    it("Is reverted if the zero chain id is passed", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.resetAccommodationGuard(0, TOKEN_ADDRESS)
      ).to.be.revertedWithCustomError(guard, REVERT_ERROR_ZERO_CHAIN_ID);
    });

    it("Is reverted if the zero token address is passed", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.resetAccommodationGuard(FIRST_CHAIN, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(guard, REVERT_ERROR_ZERO_TOKEN_ADDRESS);
    });
  });

  describe("Function 'validateAccommodation()'", async () => {
    describe("Returns status without errors", async () => {
      it("After processing correctly configured accommodation", async () => {
        const { guard } = await setUpFixture(deployBridgeGuard);
        await guard.setBridge(deployer.address);

        await guard.configureAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TEN_SECONDS,
          TWO_THOUSANDS
        );

        const validationResult = await guard.callStatic.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        );

        expect(validationResult).to.eq(ValidationStatus.NO_ERROR);
      });

      it("If accommodation overflows volume limit, but time frame is ended", async () => {
        const { guard } = await setUpFixture(deployBridgeGuard);
        await guard.setBridge(deployer.address);

        await guard.configureAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TEN_SECONDS,
          TWO_THOUSANDS
        );

        await guard.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        );

        await guard.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        );

        const recordedValues = await guard.getAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS
        );

        expect(recordedValues.currentVolume).to.eq(TWO_THOUSANDS);

        await wait(11);

        await guard.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        );

        const fourthValidationResult =
          await guard.callStatic.validateAccommodation(
            FIRST_CHAIN,
            TOKEN_ADDRESS,
            TOKEN_ADDRESS,
            ONE_THOUSAND
          );

        expect(fourthValidationResult).to.eq(ValidationStatus.NO_ERROR);

        const newRecordedValues = await guard.getAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS
        );

        expect(newRecordedValues.currentVolume).to.eq(ONE_THOUSAND);
      });
    });

    describe("Returns error code", async () => {
      it("In case of unconfigured accommodation", async () => {
        const { guard } = await setUpFixture(deployBridgeGuard);
        await guard.setBridge(deployer.address);

        const validationResult = await guard.callStatic.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        );

        expect(validationResult).to.eq(ValidationStatus.TIME_FRAME_NOT_SET);
      });

      it("If the amount is bigger than allowed volume", async () => {
        const { guard } = await setUpFixture(deployBridgeGuard);
        await guard.setBridge(deployer.address);

        await guard.configureAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TEN_SECONDS,
          ONE_THOUSAND
        );

        const validationResult = await guard.callStatic.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          TWO_THOUSANDS
        );

        expect(validationResult).to.eq(ValidationStatus.VOLUME_LIMIT_REACHED);
      });

      it("After amount overflows the cap", async () => {
        const { guard } = await setUpFixture(deployBridgeGuard);
        await guard.setBridge(deployer.address);

        await guard.configureAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TEN_SECONDS,
          TWO_THOUSANDS
        );

        await guard.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        );

        await guard.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        );

        const recordedValues = await guard.getAccommodationGuard(
          FIRST_CHAIN,
          TOKEN_ADDRESS
        );

        expect(recordedValues.currentVolume).to.eq(TWO_THOUSANDS);

        const thirdValidationResult =
          await guard.callStatic.validateAccommodation(
            FIRST_CHAIN,
            TOKEN_ADDRESS,
            TOKEN_ADDRESS,
            ONE_THOUSAND
          );

        expect(thirdValidationResult).to.eq(
          ValidationStatus.VOLUME_LIMIT_REACHED
        );
      });
    });

    it("Is reverted if the caller is not a bridge", async () => {
      const { guard } = await setUpFixture(deployBridgeGuard);

      await expect(
        guard.validateAccommodation(
          FIRST_CHAIN,
          TOKEN_ADDRESS,
          TOKEN_ADDRESS,
          ONE_THOUSAND
        )
      ).to.be.revertedWithCustomError(guard, REVERT_ERROR_CALLER_NOT_BRIDGE);
    });
  });
});