"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// ../node_modules/node-pty/lib/shared/conout.js
var require_conout = __commonJS({
  "../node_modules/node-pty/lib/shared/conout.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getWorkerPipeName = void 0;
    function getWorkerPipeName(conoutPipeName2) {
      return conoutPipeName2 + "-worker";
    }
    exports2.getWorkerPipeName = getWorkerPipeName;
  }
});

// ../node_modules/node-pty/lib/worker/conoutSocketWorker.js
Object.defineProperty(exports, "__esModule", { value: true });
var worker_threads_1 = require("worker_threads");
var net_1 = require("net");
var conout_1 = require_conout();
var conoutPipeName = worker_threads_1.workerData.conoutPipeName;
var conoutSocket = new net_1.Socket();
conoutSocket.setEncoding("utf8");
conoutSocket.connect(conoutPipeName, function() {
  var server = net_1.createServer(function(workerSocket) {
    conoutSocket.pipe(workerSocket);
  });
  server.listen(conout_1.getWorkerPipeName(conoutPipeName));
  if (!worker_threads_1.parentPort) {
    throw new Error("worker_threads parentPort is null");
  }
  worker_threads_1.parentPort.postMessage(
    1
    /* READY */
  );
});
//# sourceMappingURL=conoutSocketWorker.js.map
