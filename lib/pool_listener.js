const net = require('net');

// TODO more stratum protocol support ???
//      handle too many rejected shares for pool connection

exports.newPoolConnection = function poolConnection(config) {
    let poolSocket;
    
    let subscribeObject = { id: 0,
        method: 'mining.subscribe',
        params: [ `VP/${config.version}`, null ]
    };

	poolSocket = net.createConnection({
		port: config.pool.port,
		host: config.pool.host
	}, function () {
        poolSocket.rejects = 0;
        poolSocket.isConnected = true;

        poolSocket.peerEndpoint = poolSocket.remoteAddress + " " + poolSocket.remotePort.toString();

        poolSocket.setEncoding('ascii');
        poolSocket.setNoDelay(true);

        poolSocket.SendMessage(subscribeObject);

        // if present, force all miners to auth with specified proxy wallet
        if (config.wallet && typeof config.wallet === 'string' && config.wallet.length > 0) {
            let forcedAuthorizeObject = { id: 0,
                method: 'mining.authorize',
                params: [ config.wallet.split("/")[0].split("#")[0].split(".")[0], config.password?config.password:"x" ]
            };
            poolSocket.setAuthorizeObject(forcedAuthorizeObject);
            poolSocket.SendMessage(poolSocket.getAuthorizeObject());
            console.log(`Connected to ${config.pool.host}:${config.pool.port} for ${poolSocket.getMinerAddress()}`);

        } else {
            // if we already know the authorize from miner, send it ...
            if (poolSocket.getAuthorizeObject()) {
                poolSocket.SendMessage(poolSocket.getAuthorizeObject());
                console.log(`Connected to ${config.pool.host}:${config.pool.port} for ${poolSocket.getMinerAddress()}`);
            } else {
                console.log(`Connected to ${config.pool.host}:${config.pool.port} needs authorization from miner`);
            }
        }
    });
    poolSocket.on('error', function(err) {
        console.log(poolSocket.getPoolFriendlyName(), "pool socket error", err);
    });
    
    poolSocket.miners = new Map();
    
    poolSocket.minerAdd = function(minerId, socket) {
        if (poolSocket.closingTimeout) {
            clearTimeout(poolSocket.closingTimeout);
        }
        poolSocket.miners.set(minerId, socket);
        console.log("miner", minerId, "added to pool", poolSocket.getPoolFriendlyName());
    }
    poolSocket.minerDel = function(minerId) {
        if (poolSocket.miners.has(minerId)) {
            poolSocket.miners.delete(minerId);
            console.log("miner", minerId, "removed from pool", poolSocket.getPoolFriendlyName());
            if (poolSocket.miners.size == 0) {
                if (poolSocket.closingTimeout) {
                    clearTimeout(poolSocket.closingTimeout);
                }
                poolSocket.closingTimeout = setTimeout(()=>{
                    if (poolSocket.getIsConnected() !== false) {
                        console.log(poolSocket.getPoolFriendlyName(), "closing connection, no miners connected for 15 seconds");
                        try {
                            poolSocket.destroy();
                        } catch (e) {
                        }
                    }
                }, 15000);
            }
        }
    }
    
    poolSocket.getPoolFriendlyName = function() {
        let connectedStr = poolSocket.getIsConnected()===false?"(disconnected)":"";
        if (poolSocket.miner) {
            return poolSocket.miner + connectedStr;
        }
        return poolSocket.peerEndpoint.split(" ")[0] + connectedStr;
    }
    
    poolSocket.getIsConnected = function () {
        return poolSocket.isConnected;
    }
    poolSocket.getMinerAddress = function () {
        return poolSocket.miner;
    }
    poolSocket.getAuthorizeObject = function () {
        return poolSocket.authorizeObject;
    }
    poolSocket.setAuthorizeObject = function (object) {
        poolSocket.authorizeObject = object;
        poolSocket.miner = object.params[0].split("/")[0].split("#")[0].split(".")[0];
    }
    poolSocket.getSubscribeObjectResponse = function () {
        return poolSocket.subscribeResponseObject;
    }
    poolSocket.getShareTargetObject = function () {
        return poolSocket.setTargetObject;
    }
    poolSocket.getNotifyObject = function () {
        return poolSocket.notifyObject;
    }
    poolSocket.getExtraNonce = function () {
        return poolSocket.extraNonce;
    }
    poolSocket.isExtraNonceSubscribed = function() {
        return poolSocket.extraNonceSubscribed;
    };
    poolSocket.sendExtraNonceSubscribe = function (obj) {
        if (!poolSocket.extraNonceSubscribed) {
            poolSocket.extraNonceSubscribed = true;
            obj.id = 0;
            poolSocket.SendMessage(obj);
        }
    }
    poolSocket.SendMessage = function (object) {
        return poolSocket.write(JSON.stringify(object) + "\n");
    }
    
    // main pool socket
    let data = "";
    poolSocket.on('data', (chunk) => {
        if (typeof chunk !== 'string') {
            return;
        }
        data += chunk;
        let di = data.indexOf('\n');
        while (di > -1) {
            let message = data.substr(0,di);
            data = data.substr(di+1);
            di = data.indexOf('\n');
            let obj;
            try {
                obj = JSON.parse(message);
            } catch(e) {
                console.log(poolSocket.getPoolFriendlyName(), "error parsing message from pool", e);
                return;
            }
            // process messages
            if (obj.id || obj.id === 0) {
                // forward to specific miner
                let miner = undefined;
                let minerId = obj.id;
                if (minerId && poolSocket.miners.has(minerId)) {
                    miner = poolSocket.miners.get(minerId);
                    // get message id used by miner
                    let msgId = miner.getMsgId();
                    obj.id = msgId;
                    //console.log(poolSocket.getPoolFriendlyName(), "forward to miner:", minerId, obj);
                    miner.write(JSON.stringify(obj) + '\n');
                }
                // check for mining.subscribe response
                if (Array.isArray(obj.result) && obj.result.length == 2) {
                    poolSocket.extraNonce = obj.result[1];
                    poolSocket.subscribeResponseObject = obj;
                    // forward data to all miners of this pool
                    poolSocket.miners.forEach(function(value,key) {
                        value.sendExtraNonce();
                    });
                    console.log(poolSocket.getPoolFriendlyName(), "pool assigned nonce", poolSocket.extraNonce);
                    
                } else if (obj.id) {
                    // check accepted share result
                    if (obj.error) {
                        console.log('miner', minerId, 'share rejected id', obj.id, obj.error, miner?miner.peerEndpoint:"", "on pool", poolSocket.getPoolFriendlyName());
                        poolSocket.rejects++;
                        if (poolSocket.rejects > 10) {
                            console.log(poolSocket.getPoolFriendlyName(), 'WARN, too many consecutive rejected shares !!!');
                            poolSocket.rejects = 0;
                        }
                        if (miner) {
                            if (!miner.isExtraNonceSubscribed()) {
                                console.log('miner', minerId, "WARN, miner may not be supported", miner.getMinerSoftware(), miner.peerEndpoint);
                            }
                        }
                    } else if (obj.result === true) {
                        //console.log ('miner', minerId, 'share accepted id', obj.id, miner?miner.peerEndpoint:"", "on pool", poolSocket.getPoolFriendlyName());
                        poolSocket.rejects = 0;
                    }
                }

            } else if (obj.method === "mining.set_target" || obj.method === "mining.notify") {
                // cache job and target
                if (obj.method === 'mining.notify') {
                    poolSocket.notifyObject = obj;
                    // forward data to all miners of this pool
                    poolSocket.miners.forEach(function(value,key) {
                        value.setNotifyObject(obj);
                    });
                }
                else {
                    poolSocket.setTargetObject = obj;
                    // forward data to all miners of this pool
                    poolSocket.miners.forEach(function(value,key) {
                        value.setShareTargetObject(obj);
                    });
                }
            } else if (obj.method === "mining.set_extranonce") {
                poolSocket.extraNonce = obj.params[0];
                // forward data to all miners of this pool
                poolSocket.miners.forEach(function(value,key) {
                    value.sendExtraNonce();
                });
                
            } else {
                
                console.log(poolSocket.getPoolFriendlyName(), "unknown response from pool", obj);
                
            }
        }
    });
    poolSocket.on('close', function() {
        console.log(poolSocket.getPoolFriendlyName(), "pool connection lost");
        poolSocket.rejects = 0;
        poolSocket.isConnected = false;
        poolSocket.extraNonce = undefined;
        poolSocket.authorizeObject = undefined;
        poolSocket.subscribeResponseObject = undefined;
    });
	return poolSocket;
};
