// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC
/// @notice Testnet-only 6-decimal ERC-20 faucet (matches Arc's native USDC decimals).
/// Never deployed on mainnet; the real USDC address is used there instead.
contract MockUSDC is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;
    uint256 public constant FAUCET_AMOUNT = 1000 * 10 ** DECIMALS; // 1000 USDC per claim
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucetClaim;

    error FaucetCooldownActive(uint256 nextClaimTime);

    constructor() ERC20("Mock USDC", "USDC") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Public faucet: mint FAUCET_AMOUNT once per FAUCET_COOLDOWN.
    function faucet() external {
        uint256 nextClaim = lastFaucetClaim[msg.sender] + FAUCET_COOLDOWN;
        if (block.timestamp < nextClaim) revert FaucetCooldownActive(nextClaim);
        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Owner can mint any amount (for seeding pools / demo markets).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
