const net = require('net');
const tls = require('tls');
const fs = require('fs');
const util = require('util');

const poolListener = require('./pool_listener.js');

const maxNewConnectionsPerSecond = 100;


// TODO, miner auth timeout
//       miner subscribe timeout
//       miner share timeout
//       rejected share analysis
//       rejected auth detection
//       address validation to prevent pool connection spam
//       pool working detection, backup pools, default pool ...
//       more stratum protocol support ???


// max number of miners we can support
// *note, appends to pool's extra nonce bytes
const maxId = 65535;      // 0xffff
//const maxId = 4;        // testing

// global variables
var poolConnections = new Map();
var miners = new Map();

var usedIds = new Map();
var connectionsMaxed = false;

var lastPoolConnectionStart = 0;
var waitingForPoolConnection = false;

var id = 1;
var connectionsPerSecond = 0;

exports.createMiningListener = function createMiningListener(config) {
    
    let resetConnectionRate = function() {
        connectionsPerSecond = 0;
        setTimeout(resetConnectionRate, 1000);
    };
    setTimeout(resetConnectionRate, 1000);
    
    let handleNewClient = function(socket) {
        // cache the remote address
        socket.peerEndpoint = socket.remoteAddress + " " + socket.remotePort.toString();
        socket.on('error', (err) => {
            let minerId = socket.minerId?socket.minerId:0;
            console.log("miner", minerId, "socket error", err.code, "from ip", socket.peerEndpoint);
        });

        // limit connections per second
        connectionsPerSecond++;
        if (connectionsPerSecond > maxNewConnectionsPerSecond) {
            // do not flood logs on connection spam ...
            if (connectionsPerSecond == (maxNewConnectionsPerSecond + 1)) {
                console.log("WARN, ignore new connection; rate limiting to", maxNewConnectionsPerSecond, "per second");
            }
            setTimeout( ()=>{ try { socket.destroy();} catch(e) {} }, 5000);
            return;
        }
        if (connectionsMaxed === true) {
            setTimeout( ()=>{ try { socket.destroy();} catch(e) {} }, 5000);
            return;
        }

        // find next unique id for miner
        let tries = 0;
        let minerId = id;
        while (usedIds.has(minerId)) {
            minerId = ++id;
            if (minerId >= maxId) {
                id = 1;
            }
            tries++;
            if (tries >= maxId) {
                connectionsMaxed = true;
                console.log("WARN, max miner connections unable to accept more !!!");
                setTimeout(()=>{ try { socket.destroy();} catch(e) {} }, 5000);
                return;
            }
        }
        usedIds.set(minerId, true);

        // init variables for client
        socket.minerId = minerId;
        socket.extraExtraNonce = socket.minerId.toString(16).padStart(4, '0'); // max minerId: 0xffff (65535)
        socket.lastIds = [];

        socket.authorized = false;
        socket.subscribed = false;
        socket.extraNonceSubscribed = false;
        
        socket.processBufferTimeout = undefined;
        socket.lastNotifyTime = 0;
        
		miners.set(minerId, socket);

        socket.setEncoding('ascii');
        socket.setNoDelay(true);

        console.log("miner", minerId, "connected", "from ip", socket.peerEndpoint);
        
        socket.getMsgId = function() {
            if (socket.lastIds.length > 0) {
                return socket.lastIds.shift();
            }
            return 0;
        };
        socket.isReadyForFirstJob = function() {
            return socket.authorized && socket.subscribed;
        };
        socket.SendMessage = function(obj) {
            //console.log("to miner", obj);
            socket.write(JSON.stringify(obj) + '\n');
        };
        socket.sendFirstJob = function() {
            if (socket.firstJobSent === true) {
                console.log("WARN, first job already sent!", socket.minerId);
                return;
            }
            let pool = socket.getPool();
            // if available, send target if needed
            if (!socket.lastShareTargetObject) {
                let shareTarget = pool.getShareTargetObject();
                if (shareTarget) {
                    socket.setShareTargetObject(shareTarget);
                } else {
                    //console.log("missing share target", socket.minerId);
                    return;
                }
            }
            // if available, send mining job
            let job = socket.notifyObject;
            if (job) {
                // force clean job as first job
                if (job && job.params && job.params.length > 6) {
                    job.params[7] = true;
                    socket.SendMessage(job);
                    socket.firstJobSent = true;
                } else {
                    console.log("WARN, invalid job from pool");
                    return;
                }
            } else {
                //console.log("missing job", socket.minerId);
                return;
            }
        };
        socket.getPool = function() {
            if (socket.pool) {
                return socket.pool;
            }
            if (socket.miner && poolConnections.has(socket.miner)) {
                // we my need to add our miner to a new pool connection
                // this can happen if a pool loses connection
                let pool = poolConnections.get(socket.miner);
                if (pool.getIsConnected() !== false) {
                    if (socket.lostPoolTimer) { clearTimeout(socket.lostPoolTimer); }
                    // update pool reference for this miner
                    socket.pool = poolConnections.get(socket.miner);
                    socket.sendExtraNonce();
                    socket.setShareTargetObject(socket.pool.getShareTargetObject());
                    socket.setNotifyObject(socket.pool.getNotifyObject(), Date.now());
                    socket.pool.minerAdd(socket.minerId, socket);
                    console.log("miner", socket.minerId, "switch to existing pool connection", socket.miner);
                    return socket.pool;
                }
            }
            // fallback to first pool when miner first connecting
            if ((!socket.miner || !socket.subscribeObject) && poolConnections.size > 0) {
                return poolConnections.get(poolConnections.keys().next().value);
            }
            // no pool connections, working pool connection may have been lost
            return undefined;
        };
        socket.lostPool = function() {
            //console.log("miner", socket.minerId, "lost pool");
            socket.pool = undefined; // lost pool

            // start checking for new pool connection
            let poolConnectionCheck = function() {
                // if no pool, keep checking ...
                if (socket.getPool() === undefined) {
                    if (!waitingForPoolConnection) {
                        socket.reconnectRequest();
                    }
                    if (socket.lostPoolTimer) { clearTimeout(socket.lostPoolTimer); }
                    socket.lostPoolTimer = setTimeout(poolConnectionCheck, 100);
                } else {
                    // process buffer now ... if any ...
                    if (socket.processBufferTimeout) {
                        clearTimeout(socket.processBufferTimeout);
                    }
                    if (socket.data.length > 0) {
                        socket.processBuffer();
                    }
                }
            };
            if (socket.lostPoolTimer) { clearTimeout(socket.lostPoolTimer); }
            socket.lostPoolTimer = setTimeout(poolConnectionCheck, 5000);
        };
        socket.getExtraNonce = function() {
            let pool = socket.getPool();
            let extraNonce = pool.getExtraNonce();
            if (extraNonce && extraNonce.length < 11) { // max 5 bytes pool can use, we use 3 bytes
                return extraNonce + socket.extraExtraNonce;
            }
            return extraNonce;
        };
        socket.isExtraNonceSubscribed = function() {
            return socket.extraNonceSubscribed === true;
        };
        socket.getMinerSoftware = function() {
            if (socket.minerSoftware) {
                return socket.minerSoftware;
            }
            let message = socket.subscribeObject;
            // detect miner software, multiple possible formats
            if (message.params.length > 0) {
                if (message.params.length == 1) {
                    // software
                    minerSoftware = poolListener.getSafeString((message.params[0]||""));                    
                } else if (message.params.length == 2) {
                    // software, session_id (unsupported)
                    minerSoftware = poolListener.getSafeString((message.params[0]||""));
                } else if (message.params.length > 2) {
                    // two possible formats
                    // software, session_id, host, port
                    if (!message.params[1] || message.params[1].toString().length == 0 || poolListener.getSafeNumber(message.params[1].toString()) !== 0) {
                        minerSoftware = poolListener.getSafeString((message.params[0]||""));
                    } else if (message.params[2]) {
                        // host, port, software, session_id
                        minerSoftware = poolListener.getSafeString((message.params[2]||""));
                    } else {
                        console.log("miner", socket.minerId, "unable to determine miner software from ip", socket.peerEndpoint);
                    }
                }
            }
            if (!minerSoftware || minerSoftware.length < 1) {
                console.log("miner", socket.minerId, "unable to determine miner software from ip", socket.peerEndpoint);
                minerSoftware = "unknown";
            } else {
                socket.minerSoftware = minerSoftware;
            }
            return minerSoftware;
        };
        socket.sendExtraNonce = function() {
            if (socket.isReadyForFirstJob()) {
                // send extra nonce
                let extraNonce = socket.getExtraNonce();
                if (extraNonce && socket.lastExtraNonceSent !== extraNonce) {
                    socket.lastExtraNonceSent = extraNonce;
                    let set_extranonce = {
                        id: null,
                        method: "mining.set_extranonce",
                        params: [extraNonce]
                    }
                    socket.SendMessage(set_extranonce);
                }
            }
        };
        socket.setNotifyObject = function(obj, now){
            if (obj && socket.isReadyForFirstJob()) {
                let changed = false;
                let clean_job = obj.params[7];
                if (!socket.lastNotifyObject) {
                    changed = true;
                    clean_job = true;
                }
                // detect changes and force non-clean jobs true
                if (!changed && !clean_job) {
                    // force non-clean jobs true on the following changes
                    if (obj.params[2] != socket.lastNotifyObject.params[2]) { changed = true; }
                    if (obj.params[3] != socket.lastNotifyObject.params[3]) { changed = true; }
                    if (obj.params[4] != socket.lastNotifyObject.params[4]) { changed = true; }
                    if (obj.params[6] != socket.lastNotifyObject.params[6]) { changed = true; }
                    if (obj.params[8] != socket.lastNotifyObject.params[8]) { changed = true; }
                    if (changed) { 
                        //console.log("miner", socket.minerId, "non-canonical data changes, forcing non-clean job true for job", obj.params[0]);
                        clean_job = true;
                    }
                    // the following can change but not require a clean job
                    if (obj.params[0] != socket.lastNotifyObject.params[0]) { changed = true; }
                    if (obj.params[1] != socket.lastNotifyObject.params[1]) { changed = true; }
                    if (obj.params[7] != socket.lastNotifyObject.params[7]) { changed = true; }
                }
                // take any clean_job overrides
                obj.params[7] = clean_job;

                socket.lastNotifyObject = socket.notifyObject;
                socket.notifyObject = obj;

                if (changed || clean_job) {
                    socket.lastNotifyTime = now;
                    socket.SendMessage(obj);
                }
            }
        };
        socket.setShareTargetObject = function(obj){
            if (obj && socket.isReadyForFirstJob()) {
                socket.lastShareTargetObject = socket.shareTargetObject;
                socket.shareTargetObject = obj;
                if (!socket.lastShareTargetObject || (socket.lastShareTargetObject.params && socket.shareTargetObject.params && socket.lastShareTargetObject.params[0] !== socket.shareTargetObject.params[0])) {
                    socket.SendMessage(obj);
                }
            }
        };
        socket.reconnectRequest = function() {
            let sinceLastFailedAttempt = (Date.now() - lastPoolConnectionStart);
            if (sinceLastFailedAttempt > 15000 && !socket.pool && waitingForPoolConnection !== true) {
                waitingForPoolConnection = true;
                lastPoolConnectionStart = Date.now();
                console.log("miner", socket.minerId, "pool connection required");
                let pool = poolListener.newPoolConnection(config);
                let poolClosed = function () {
                    let mineraddr = pool.getMinerAddress();
                    if (mineraddr && poolConnections.has(mineraddr)) {
                        poolConnections.delete(mineraddr);
                    }
                };
                pool.on('close', poolClosed);
                
                let doneWaitingConnected = function() {
                    pool.removeListener('connect', doneWaitingConnected);
                    lastPoolConnectionStart = 0; // connect success, allow another right away
                };
                let doneWaiting = function() {
                    pool.removeListener('close', doneWaiting);
                    pool.removeListener('connect', doneWaiting);
                    pool.removeListener('connect', doneWaitingConnected);
                    waitingForPoolConnection = false;
                };
                pool.on('close', doneWaiting);

                if (socket.authorizeObject) {
                    pool.on('connect', doneWaiting);
                    pool.on('connect', doneWaitingConnected);

                    pool.setAuthorizeObject(socket.authorizeObject);
                    poolConnections.set(pool.getMinerAddress(), pool);
                }
                
                socket.pool = pool;
                pool.minerAdd(socket.minerId, socket);
                
            } else if (socket.pool) {
                console.log("miner", socket.minerId, "reconnect to for pool not needed");
            }
        };
        socket.processBuffer = function() {
            if (socket.processBufferTimeout) { clearTimeout(socket.processBufferTimeout); }
            
            // socket to pool
            let pool = socket.getPool();
            if (pool === undefined) {
                if (!waitingForPoolConnection && !socket.lostPoolTimer) {
                    socket.reconnectRequest();
                }
                // must delay processing buffer in some cases
                if (!socket.authorized || !socket.subscribed) {
                    socket.processBufferTimeout = setTimeout(() => { socket.processBuffer(); }, 1000);
                    return;
                }
            }
            // if pool.getIsConnected() returns undefined, we are waiting for connection attempt
            if (pool && pool.getIsConnected() === false) {
                // we may have an outdated pool reference
                let tmpaddr = pool.getMinerAddress();
                if (poolConnections.has(tmpaddr)) {
                    let tmppool = poolConnections.get(tmpaddr);
                    // if updated pool reference is connected
                    if (tmppool.getIsConnected() !== false) {
                        // remove from current pool
                        pool.minerDel(socket.minerId);
                        // update pool reference
                        pool = tmppool;
                        pool.minerAdd(socket.minerId, socket);
                        socket.pool = tmppool;
                        socket.setShareTargetObject(tmppool.getShareTargetObject());
                        socket.setNotifyObject(tmppool.getNotifyObject(), Date.now());
                        reconnectionRequired = false;
                        console.log("miner", socket.minerId, "WARN, updated pool reference");
                    } else {
                        poolConnections.delete(tmpaddr);
                        console.log("miner", socket.minerId, "cleanup stale pool connection");
                    }
                }
            }
            // wait for pool subscribe to complete
            if (pool && pool.getSubscribeObjectResponse() === undefined) {
                console.log("miner", socket.minerId, "waiting for pool subscription");
                // we need to delay processing this clients buffer, until we have asubscribed with pool
                if (socket.processBufferTimeout) {
                    clearTimeout(socket.processBufferTimeout);
                }
                socket.processBufferTimeout = setTimeout(() => { socket.processBuffer(); }, 100);
                return;
            }
            if (pool && socket.authorized && socket.subscribed && (!socket.shareTargetObject || !socket.notifyObject)) {
                console.log("miner", socket.minerId, "waiting for pool job and share target");
                // update our references if needed
                socket.setShareTargetObject(pool.getShareTargetObject());
                socket.setNotifyObject(pool.getNotifyObject(), Date.now());
                // we need to delay processing this clients buffer, until we have all info from pool
                if (socket.processBufferTimeout) {
                    clearTimeout(socket.processBufferTimeout);
                }
                socket.processBufferTimeout = setTimeout(() => { socket.processBuffer(); }, 100);
                return;
            }
            // process buffer
            let di = socket.data.indexOf('\n');
            while (di > -1) {
                let message = socket.data.substr(0,di);
                socket.data = socket.data.substr(di+1);
                di = socket.data.indexOf('\n');
                let obj;
                try {
                    obj = JSON.parse(message);
                } catch(e) {
                    console.log("miner", socket.minerId, "invalid json message", "from ip", socket.peerEndpoint);
                    return;
                }
                //console.log("fromMiner:", obj);
                let originalId = obj.id;
                if (originalId) {
                    // capture message id for message routing by pool_listener
                    socket.lastIds.push(originalId);                
                    // override id with miner id for message routing by pool_listener
                    obj.id = socket.minerId;
                }

                // if we have the subscribe response, do not forward to main pool, already subscribed
                if (obj.method == 'mining.subscribe') {
                    // if they have not already subscribed, todo track spam
                    if (!socket.subscribed) {
                        socket.subscribed = true;
                        socket.subscribeObject = obj;
                        // we are handling this id
                        socket.lastIds.pop();
                        // get cached response and update for this miner
                        let response = pool.getSubscribeObjectResponse();
                        response.id = originalId;
                        let extraNonce = socket.getExtraNonce();
                        socket.lastExtraNonceSent = extraNonce;
                        response.result[1] = extraNonce;
                        // pools only get max 8 bytes, 16 hex chars
                        if (extraNonce.length > 16) {
                            console.log("ERROR, pool provided unsupported extra nonce!");
                        }
                        socket.SendMessage(response);

                        if (!socket.firstJobSent && socket.isReadyForFirstJob()) {
                            //console.log("sending first job on subscribe", socket.minerId);
                            socket.sendFirstJob();
                        }
                        console.log("miner", socket.minerId, "using software (", socket.getMinerSoftware(), ")", "from ip", socket.peerEndpoint);
                    } else {
                        // we are handling this id
                        socket.lastIds.pop();
                        let response = pool.getSubscribeObjectResponse();
                        response.id = originalId;
                        response.result[1] = socket.lastExtraNonceSent;
                        socket.SendMessage(response);
                    }

                } else if (obj.method == 'mining.authorize') {
                    // if they have not authorized already, todo track spam
                    if (!socket.miner) {
                        let handled = true;
                        let address = poolListener.getSafeAddress(obj.params[0]);
                        // if we are forcing a wallet address for proxy, override miner provided address
                        if (config.wallet && typeof config.wallet === 'string' && config.wallet.length > 0) {
                            address = poolListener.getSafeAddress(config.wallet);
                        }
                        
                        socket.miner = address;
                        socket.authorizeObject = obj;

                        // if we have not authorized with the pool
                        let authObj = pool.getAuthorizeObject();
                        if (!authObj) {
                            console.log("miner", socket.minerId, "authorizing pool connection for miner", socket.miner);
                            pool.setAuthorizeObject(obj);
                            poolConnections.set(socket.miner, pool);
                            pool.SendMessage(pool.getAuthorizeObject());
                            // we are not handling this request directly
                            handled = false;

                        } else {
                            // check if we are connected to the correct pool for miner address
                            if (authObj.params && authObj.params[0].indexOf(socket.miner) == -1) {
                                let reconnectionRequired = true;
                                // does pool connection already exist for miner address
                                if (poolConnections.has(socket.miner)) {
                                    let tmppool = poolConnections.get(socket.miner);
                                    if (tmppool.getIsConnected() !== false) {
                                        console.log("miner", socket.minerId, "switching to existing pool connection");
                                        // remove from current pool
                                        pool.minerDel(socket.minerId);
                                        // use existing pool connection for miner address
                                        pool = tmppool;
                                        socket.pool = tmppool;
                                        socket.sendExtraNonce();
                                        socket.setShareTargetObject(pool.getShareTargetObject());
                                        socket.setNotifyObject(pool.getNotifyObject(), Date.now());
                                        // miner needs first job again for new pool
                                        socket.firstJobSent = false;
                                        reconnectionRequired = false;
                                    }
                                }
                                if (reconnectionRequired === true) {
                                    // miner needs a new pool connection authorized for miner address
                                    console.log("miner", socket.minerId, "new pool connection required");
                                    // remove from current pool
                                    pool.minerDel(socket.minerId);
                                    // use new pool connection for miner address
                                    pool = poolListener.newPoolConnection(config);
                                    pool.setAuthorizeObject(obj);
                                    poolConnections.set(socket.miner, pool);
                                    let poolClosed = function () {
                                        let mineraddr = pool.getMinerAddress();
                                        if (mineraddr && poolConnections.has(mineraddr)) {
                                            poolConnections.delete(mineraddr);
                                        }
                                    };
                                    pool.on('close', poolClosed);
                                    
                                    socket.pool = pool;
                                    // miner needs first job again for new pool
                                    socket.firstJobSent = false;
                                    // we are not handling this request directly
                                    handled = false;
                                }

                            } else {
                                // using proxy wallet or already on correct pool
                                // make sure it exists in our pool connection list
                                if (!poolConnections.has(socket.miner)) {
                                    poolConnections.set(socket.miner, pool);
                                }
                                socket.pool = pool;
                                socket.sendExtraNonce();
                                socket.setShareTargetObject(pool.getShareTargetObject());
                                socket.setNotifyObject(pool.getNotifyObject(), Date.now());
                            }
                        }

                        socket.authorized = true;
                        waitingForPoolConnection = false;
                        lastPoolConnectionStart = 0;

                        // this miner is now active for the pool, add to pools client list
                        pool.minerAdd(socket.minerId, socket);

                        // already authed ?
                        if (handled == true) {
                            socket.lastIds.pop(); // we are handling, pop the id
                            socket.SendMessage({id: originalId, result: true, error: null});
                        }

                        // send miner their first job if needed
                        if (!socket.firstJobSent && socket.isReadyForFirstJob()) {
                            socket.sendFirstJob();
                        }
                    }

                } else if (obj.method == "mining.submit") {
                    // ignore if not authorized or subscribed, todo track spam
                    if (socket.authorized && socket.subscribed) {
                        // insert extraExtraNonce into job params
                        if (obj.params && obj.params.length > 3) {
                            obj.params[3] = socket.extraExtraNonce + obj.params[3];
                        }
                        // forward to pool
                        if (pool && pool.getIsConnected() !== false && pool.hasMiner(socket.minerId)) {
                            pool.SendMessage(obj);
                        } else {
                            console.log("miner", socket.minerId, "unable to submit share, no pool connection");
                            // we are handling this as no pools are connected ...
                            socket.lastIds.pop(); // we are handling, pop the id
                            socket.SendMessage({id: originalId, result: false, error: [21, 'pool not found']});
                        }
                    } else if (!socket.subscribed) {
                        // we are handling this as no pools are connected ...
                        socket.lastIds.pop(); // we are handling, pop the id
                        socket.SendMessage({id: originalId, result: false, error: [25, 'not subscribed']});
                    } else {
                        // we are handling this as no pools are connected ...
                        socket.lastIds.pop(); // we are handling, pop the id
                        socket.SendMessage({id: originalId, result: false, error: [24, 'not authorized']});
                    }

                } else if (obj.method == "mining.extranonce.subscribe") {
                    socket.lastIds.pop(); // we are handling, pop the id
                    socket.SendMessage({id: originalId, result: true, error: null});
                    // ignore if already subscribed
                    if (!socket.extraNonceSubscribed) {
                        socket.extraNonceSubscribed = true;
                        // subscribe on pool if needed
                        if (pool && pool.getIsConnected() !== false) {
                            pool.sendExtraNonceSubscribe();
                        }
                        // send miner their first/second job if needed to get correct extra nonce
                        socket.firstJobSent = (socket.lastExtraNonceSent === socket.getExtraNonce());
                        // send them the extra nonce
                        socket.sendExtraNonce();
                        // send mining job if needed
                        if (!socket.firstJobSent && socket.isReadyForFirstJob()) {
                            //console.log("sending first job on extranonce.subscribe", socket.minerId);
                            socket.sendFirstJob();
                        }
                    }

                } else if (obj.method == "mining.pbaas.subscribe") {
                    socket.lastIds.pop(); // we are handling, pop the id
                    socket.SendMessage({id: originalId, result: true, error: null});
                    // ignore if already subscribed
                    if (!socket.pbaasSubscribed) {
                        socket.pbaasSubscribed = true;
                        // subscribe on pool if needed
                        if (pool && pool.getIsConnected() !== false) {
                            pool.sendPBaasSubscribe();
                        }
                    }
                    
                } else {

                    // unknown method, ignore
                    socket.lastIds.pop(); // we are handling, pop the id
                    socket.SendMessage({id: originalId, result: false, error: [20, 'unknown method']});
                    console.log("miner", socket.minerId, "unknown stratum method (", obj.method, ") from ip", socket.peerEndpoint);

                }
            }
        };

        socket.data = "";
        socket.on('data', (chunk) => {
            if (typeof chunk !== 'string') {
                // TODO, potential SSL connection, upgrade to SSL ???
                console.log("invalid chunk type, dropping miner", "from ip", socket.peerEndpoint);
                socket.destroy();
                return;
            }
            socket.data += chunk;
            if (socket.processBufferTimeout) {
                clearTimeout(socket.processBufferTimeout);
            }
            socket.processBuffer();
		});
        socket.once('close', () => {
            if (socket.processBufferTimeout) {
                clearTimeout(socket.processBufferTimeout);
            }
            connectionsMaxed = false;
            if (usedIds.has(socket.minerId)) {
                usedIds.delete(socket.minerId);
            }
            if (miners.has(socket.minerId)) {
                miners.delete(socket.minerId);
            }
            let poolSocket = socket.getPool();
            if (poolSocket) {
                poolSocket.minerDel(socket.minerId);
            }
            console.log('miner', socket.minerId, 'disconnected', "from ip", socket.peerEndpoint);
        });
	};
    
    console.log('Using pool:', config.pool.host, config.pool.port);
    
    if (config.stratumSSL && config.stratumSSL.enabled === true && config.stratumSSL.key && config.stratumSSL.cert) {
        config.stratumPort = config.stratumPort||443;
        let TLSoptions = {
            key: fs.readFileSync(config.stratumSSL.key),
            cert: fs.readFileSync(config.stratumSSL.cert),
            passphrase: config.stratumSSL.passphrase,
            requireCert: true
        };
        tls.createServer(TLSoptions, handleNewClient).listen(config.stratumPort||443, function() {
           console.log('Stratum proxy listening on stratum+ssl port', config.stratumPort); 
        });

    } else {
        config.stratumPort = config.stratumPort||8000;
        net.createServer(handleNewClient).listen(config.stratumPort||8000, function() {
            console.log('Stratum proxy listening on stratum+tcp port', config.stratumPort);
        });
    }
};
exports.miners = miners;
exports.poolConnections = poolConnections;
