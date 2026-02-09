// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AdminConfigBug {
    address public owner;
    address public treasury;
    uint256 public feeBps;

    constructor() {
        owner = msg.sender;
        treasury = msg.sender;
        feeBps = 30;
    }

    // BUG: missing onlyOwner
    function setTreasury(address t) external { treasury = t; }

    // BUG: missing onlyOwner
    function setFeeBps(uint256 bps) external { feeBps = bps; }
}
