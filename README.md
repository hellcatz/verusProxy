# verusProxy
**Experimental** stratum proxy for VerusCoin based mining pools. This is currently work in progress.

# Setup
    git clone https://github.com/hellcatz/verusProxy
    cd verusProxy
    npm install

# Modify config.json

Modify the stratumPort and pool parameters as needed

    "stratumPort": 8000,
    "pool" : {
      "host" : "na.luckpool.net",
      "port" : 3956
    },

Optionally, you may force all miners to use the specified proxy wallet and password. By default it will use authorization from miner.

    "wallet": "WALLET_ADDRESS",
    "password": "x"

# Run
    node proxy.js
    
    VerusProxy v0.1 by hellcatz
    Using 1 out of 1 total threads
    Using pool: na.luckpool.net 3956
    Stratum proxy listening on stratum+tcp port 8000


