// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract SimpleAMM {
    address public token;
    address public stable;

    uint256 public reserveToken;
    uint256 public reserveStable;

    event Swap(address indexed user, address indexed fromToken, address indexed toToken, uint256 amountIn, uint256 amountOut);

    constructor(address _token, address _stable) {
        token = _token;
        stable = _stable;
    }

    function seed(uint256 tokenAmt, uint256 stableAmt) external {
        IERC20(token).transferFrom(msg.sender, address(this), tokenAmt);
        IERC20(stable).transferFrom(msg.sender, address(this), stableAmt);
        reserveToken += tokenAmt;
        reserveStable += stableAmt;
    }

    function swapTokenForStable(uint256 amountIn) external {
        IERC20(token).transferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = (amountIn * reserveStable) / reserveToken;
        reserveToken += amountIn;
        reserveStable -= amountOut;

        IERC20(stable).transfer(msg.sender, amountOut);
        emit Swap(msg.sender, token, stable, amountIn, amountOut);
    }

    function swapStableForToken(uint256 amountIn) external {
        IERC20(stable).transferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = (amountIn * reserveToken) / reserveStable;
        reserveStable += amountIn;
        reserveToken -= amountOut;

        IERC20(token).transfer(msg.sender, amountOut);
        emit Swap(msg.sender, stable, token, amountIn, amountOut);
    }
}
