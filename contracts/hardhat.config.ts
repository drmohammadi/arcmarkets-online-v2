import { HardhatUserConfig } from "hardhat/config";                                                                     import "@nomicfoundation/hardhat-toolbox";
  import "solidity-coverage";
  import * as dotenv from "dotenv";

  dotenv.config();

  const config: HardhatUserConfig = {
    solidity: {
      version: "0.8.20",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
      },
    },
    networks: {
      hardhat: {
        chainId: 31337,
      },
      arcTestnet: {
        chainId: 5042002,
        url: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io",
        accounts: process.env.DEPLOYER_PRIVATE_KEY
          ? [process.env.DEPLOYER_PRIVATE_KEY]
          : [],
      },
      // Mainnet guard: only activates when all three env vars are set.
      ...(process.env.ARC_MAINNET_RPC_URL &&
      process.env.ARC_MAINNET_CHAIN_ID &&
      process.env.ARC_MAINNET_USDC_ADDRESS
        ? {
            arcMainnet: {
              chainId: parseInt(process.env.ARC_MAINNET_CHAIN_ID, 10),
              url: process.env.ARC_MAINNET_RPC_URL,
              accounts: process.env.DEPLOYER_PRIVATE_KEY
                ? [process.env.DEPLOYER_PRIVATE_KEY]
                : [],
            },
          }
        : {}),
    },
    paths: {
      sources: "./src",
      tests: "./test",
      cache: "./cache",
      artifacts: "./artifacts",
    },
  };

  export default config;