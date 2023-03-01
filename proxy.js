const cluster = require("cluster");
const totalCPUs = require("os").cpus().length;
const minerListener = require('./lib/miner_listener.js');

const config = require('./config.json');

config.version = "0.1.4";

// TODO, stratumProxy/poolConnection engine (50%)
//       api/stats engine (0%)
//       validate config

if (cluster.isMaster) {
    console.log(`VerusProxy v${config.version} by hellcatz`);
    //console.log(`Master ${process.pid} is running`);

    let my_fork = function() {
        let worker = cluster.fork();

        // example fork inter-process communications
        worker.on('message', function(msg){
            console.log('from worker:', msg);
            //worker.send({chat: "Master got worker message"});
        });
        return worker;
    };

    // allow multithreading for big farms with 1000's of workers
    let numThreads = 1; // default to 1, simple home proxy mode
    if (config.threads && typeof config.threads === 'string') {
        // assume string is "auto", leave 1 thread idle
        numThreads = totalCPUs - 1;
    } else if (config.threads && typeof config.threads === 'number') {
        numThreads = Math.min(Math.max(config.threads, 1), totalCPUs);
    }
    
    console.log(`Using ${numThreads} out of ${totalCPUs} total threads`);
    
    // fork the threads!
    for (let i = 0; i < numThreads; i++) {
        my_fork();
    }

    cluster.on("exit", (worker, code, signal) => {
        console.log(`worker ${worker.process.pid} died, forking again`);
        my_fork();
    });

} else {

    //console.log(`Worker ${process.pid} is running`);

    // example fork inter-process communications
    process.on('message', function(msg) {
        console.log('from master:', msg);
    });
    //process.send({chat: "Hello master from worker!"});

    if (!config.notifyTimeoutMs) {
        config.notifyTimeoutMs = 15000;
    }

    // start stratum mining server for this fork
    minerListener.createMiningListener(config);
    
    // TODO, monitor ssl certificates for updates and udpdate our listener's TLS options ...
}
