"use strict";
/**
 * Shared protocol for the Config Plane service.
 *
 * The backend (Node) reads the Command Center environment configuration (`.env`, falling
 * back to `.env.example`) and exposes a read-only, secret-masked snapshot to the
 * frontend over JSON-RPC. Secret values are NEVER sent to the browser — only a
 * "set / not set" flag and the byte length.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigPlaneService = exports.CONFIG_PLANE_SERVICE_PATH = void 0;
exports.CONFIG_PLANE_SERVICE_PATH = '/services/command-center-config-plane';
exports.ConfigPlaneService = Symbol('ConfigPlaneService');
//# sourceMappingURL=config-plane-protocol.js.map