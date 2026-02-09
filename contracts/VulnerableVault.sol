// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract VulnerableVault {
    mapping(address => uint256) public balances;

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "INSUFFICIENT");

        // ❌ Vulnerability: state update AFTER external call
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "SEND_FAIL");

        balances[msg.sender] -= amount;
        emit Withdraw(msg.sender, amount);
    }

    function vaultBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
