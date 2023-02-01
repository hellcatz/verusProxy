# verusProxy
**Experimental** stratum proxy for VerusCoin based mining pools. This is currently work in progress.  
**NOTE**: It is best to use a miner that is compatible with extra nonce subscribe (xnsub) feature.

## Setup
    sudo apt install nodejs npm
    git clone https://github.com/hellcatz/verusProxy
    cd verusProxy
    npm install

## Configure
**NOTE**: stratum port can not be the same as pool port  

    "stratumPort": 8000,
    "pool" : {
      "host" : "na.luckpool.net",
      "port" : 3956
    }

### Miner Authorization
By default, authorization from miner will be used to create pool connections for each unique miner address.  
This mode requires the miner software to support extra nonce subscription (xnsub) or will reult in low difficulty share rejects.  
  
Optionally, you may force all miners to use the specified proxy wallet partially eliminating the xnsub requirement.  
If the pool connection is lost, a new nonce will be assigned by the pool and will result in low difficulty share rejects, requiring miner to restart.  

    "wallet": "WALLET_ADDRESS",
    "password": "x"

## Run
    node proxy.js
