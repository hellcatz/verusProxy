# verusProxy
**Experimental** stratum proxy for VerusCoin based mining pools. This is currently work in progress.  

## Setup
    sudo apt install nodejs npm
    git clone https://github.com/hellcatz/verusProxy
    cd verusProxy
    npm install

## Configure
**NOTE**: stratum port can not be the same as pool port.  

    "stratumPort": 8000,
    "pool" : {
      "host" : "na.luckpool.net",
      "port" : 3956
    }

By default, authorization from miner will be used to create pool connections for each (requires xnsub support in miner software)  
Optionally, you may force all miners to use the specified proxy wallet (does not require xnsub support in miner software)  

    "wallet": "WALLET_ADDRESS",
    "password": "x"

## Run
    node proxy.js
