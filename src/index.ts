/**
 * cnproxy public API.
 *
 * @example
 * ```ts
 * import { ProxyServer } from "cnproxy";
 * const proxy = new ProxyServer({ port: 8888 });
 * proxy.use({ name: "logger", response(flow) { console.log(flow.request.url, flow.response?.statusCode); } });
 * await proxy.start();
 * ```
 */

export { ProxyServer } from "./core/proxy.ts";
export { Options, DEFAULT_OPTIONS } from "./options.ts";
export type { CnProxyOptions } from "./options.ts";
export { Flow, CnRequest, CnResponse, FlowError } from "./flow/flow.ts";
export type { FlowSummary, FlowDetail, WebSocketMessage, ClientInfo } from "./flow/flow.ts";
export { Headers } from "./flow/headers.ts";
export { FlowStore } from "./flow/store.ts";
export { RuleEngine } from "./rules/engine.ts";
export { compileFilter } from "./rules/filter.ts";
export type { Predicate } from "./rules/filter.ts";
export { CertificateAuthority } from "./cert/ca.ts";
export { AddonManager } from "./addons/manager.ts";
export type { Addon, HookName } from "./addons/types.ts";
export { setLogLevel, setColor } from "./logger.ts";
export { WebInspector } from "./web/server.ts";
