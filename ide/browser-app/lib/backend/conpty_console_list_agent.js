"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// ../node_modules/node-pty/lib/utils.js
var require_utils = __commonJS({
  "../node_modules/node-pty/lib/utils.js"(exports2) {
    var __nativePtyRequire = require;
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.loadNativeModule = exports2.assign = void 0;
    function assign(target) {
      var sources = [];
      for (var _i = 1; _i < arguments.length; _i++) {
        sources[_i - 1] = arguments[_i];
      }
      sources.forEach(function(source) {
        return Object.keys(source).forEach(function(key) {
          return target[key] = source[key];
        });
      });
      return target;
    }
    exports2.assign = assign;
    function loadNativeModule(name) {
      var dirs = ["build/Release", "build/Debug", "prebuilds/" + process.platform + "-" + process.arch];
      var relative = ["..", "."];
      var lastError;
      for (var _i = 0, dirs_1 = dirs; _i < dirs_1.length; _i++) {
        var d = dirs_1[_i];
        for (var _a = 0, relative_1 = relative; _a < relative_1.length; _a++) {
          var r = relative_1[_a];
          var dir = r + "/" + d;
          try {
            return { dir, module: __nativePtyRequire(dir + "/" + name + ".node") };
          } catch (e) {
            lastError = e;
          }
        }
      }
      throw new Error("Failed to load native module: " + name + ".node, checked: " + dirs.join(", ") + ": " + lastError);
    }
    exports2.loadNativeModule = loadNativeModule;
  }
});

// ../node_modules/node-pty/lib/conpty_console_list_agent.js
Object.defineProperty(exports, "__esModule", { value: true });
var utils_1 = require_utils();
var getConsoleProcessList = utils_1.loadNativeModule("conpty_console_list").module.getConsoleProcessList;
var shellPid = parseInt(process.argv[2], 10);
var consoleProcessList = [];
if (shellPid > 0) {
  try {
    consoleProcessList = getConsoleProcessList(shellPid);
  } catch (_a) {
    consoleProcessList = [];
  }
}
process.send({ consoleProcessList });
process.exit(0);
//# sourceMappingURL=conpty_console_list_agent.js.map
