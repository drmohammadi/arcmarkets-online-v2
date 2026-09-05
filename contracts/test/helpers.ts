import { ethers } from "hardhat";
import { MarketFactory, ConditionalTokens, MockUSDC } from "../typechain-types";

// 6-decimal USDC helpers (Arc's native decimals). ALWAYS use these, never 10**18.
export const USDC_DECIMALS = 6;
export const usdc = (n: number | string): bigint =>
  ethers.parseUnits(n.toString(), USDC_DECIMALS);

export interface DeployedSystem {
  mockUSDC: MockUSDC;
  conditionalTokens: ConditionalTokens;
  factory: MarketFactory;
}

/// Deploys the full system with the factory owning ConditionalTokens.
export async function deploySystem(): Promise<DeployedSystem> {
  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDCFactory.deploy();
  await mockUSDC.waitForDeployment();

  const CTFactory = await ethers.getContractFactory("ConditionalTokens");
  const conditionalTokens = await CTFactory.deploy();
  await conditionalTokens.waitForDeployment();

  const FactoryFactory = await ethers.getContractFactory("MarketFactory");
  const factory = await FactoryFactory.deploy(
    await mockUSDC.getAddress(),
    await conditionalTokens.getAddress()
  );
  await factory.waitForDeployment();

  // Critical wiring: the factory must OWN ConditionalTokens so it can prepareCondition
  // and pause. Ownership is transferred from the deployer to the factory.
  await conditionalTokens.transferOwnership(await factory.getAddress());

  return { mockUSDC, conditionalTokens, factory };
}

/// Creates a market resolving 1 hour from now. Returns questionId, fpmm, and conditionId.
export async function createMarket(
  system: DeployedSystem,
  resolver: string,
  fee = 200 // 2%
): Promise<{ questionId: bigint; fpmm: string; conditionId: string }> {
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const resolutionTime = now + 3600;

  const tx = await system.factory.createMarket(
    "Will it rain tomorrow?",
    "Weather",
    resolutionTime,
    resolver,
    fee
  );
  const receipt = await tx.wait();

  const event = receipt!.logs
    .map((log) => {
      try {
        return system.factory.interface.parseLog(log as any);
      } catch {
        return null;
      }
    })
    .find((e) => e?.name === "MarketCreated");

  return {
    questionId: event!.args.questionId,
    fpmm: event!.args.fpmm,
    conditionId: event!.args.conditionId,
  };
}
