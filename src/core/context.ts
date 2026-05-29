/**
 * Shared runtime context passed to request/connect/websocket handlers.
 */

import type { Options } from "../options.ts";
import type { FlowStore } from "../flow/store.ts";
import type { AddonManager } from "../addons/manager.ts";
import type { RuleEngine } from "../rules/engine.ts";
import type { CertificateAuthority } from "../cert/ca.ts";
import { compileFilter, type Predicate } from "../rules/filter.ts";

export interface ProxyContext {
  options: Options;
  store: FlowStore;
  addons: AddonManager;
  rules: RuleEngine;
  ca: CertificateAuthority;
  /** Wall-clock millis. */
  now(): number;
  /** Compiled intercept predicate (recompiled when the option changes). */
  interceptMatch(): Predicate;
}

export function createContext(deps: Omit<ProxyContext, "now" | "interceptMatch">): ProxyContext {
  let interceptExpr = deps.options.get("intercept");
  let predicate = compileFilter(interceptExpr);
  deps.options.subscribe((changed) => {
    if (changed.has("intercept")) {
      interceptExpr = deps.options.get("intercept");
      predicate = compileFilter(interceptExpr);
    }
    if (changed.has("rules")) deps.rules.load(deps.options.get("rules"));
    if (changed.has("maxFlows")) deps.store.setMax(deps.options.get("maxFlows"));
  });
  return {
    ...deps,
    now: () => Date.now(),
    interceptMatch: () => (interceptExpr ? predicate : () => false),
  };
}
