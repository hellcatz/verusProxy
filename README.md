# verusProxy
**Experimental** stratum proxy for VerusCoin based mining pools. This is currently work in progress.

# Setup
    git clone https://github.com/hellcatz/verusProxy
    cd verusProxy
    npm install

# Custom Pool

Modify the stratumPort for listening and pool connection parameters.

    "stratumPort": 8000,
    "pool" : {
      "host" : "na.luckpool.net",
      "port" : 3956
    },

By default, authorization from miner will be used to create pool connections for each.

Optionally, you may force all miners to use the specified wallet, all miners will use same pool connection.

    "wallet": "WALLET_ADDRESS",
    "password": "x"

# Run
    node proxy.js
    
    VerusProxy v0.1 by hellcatz
    Using 1 out of 1 total threads
    Using pool: na.luckpool.net 3956
    Stratum proxy listening on stratum+tcp port 8000


