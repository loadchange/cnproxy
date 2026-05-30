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
  /** Compiled request-phase intercept predicate (recompiled when the option changes). */
  interceptMatch(): Predicate;
  /** Compiled response-phase intercept predicate. */
  interceptResponseMatch(): Predicate;
}

export function createContext(deps: Omit<ProxyContext, "now" | "interceptMatch" | "interceptResponseMatch">): ProxyContext {
  let interceptExpr = deps.options.get("intercept");
  let predicate = compileFilter(interceptExpr);
  let interceptResExpr = deps.options.get("interceptResponse");
  let resPredicate = compileFilter(interceptResExpr);
  deps.options.subscribe((changed) => {
    if (changed.has("intercept")) {
      interceptExpr = deps.options.get("intercept");
      predicate = compileFilter(interceptExpr);
    }
    if (changed.has("interceptResponse")) {
      interceptResExpr = deps.options.get("interceptResponse");
      resPredicate = compileFilter(interceptResExpr);
    }
    if (changed.has("rules")) deps.rules.load(deps.options.get("rules"));
    if (changed.has("maxFlows")) deps.store.setMax(deps.options.get("maxFlows"));
  });
  return {
    ...deps,
    now: () => Date.now(),
    interceptMatch: () => (interceptExpr ? predicate : () => false),
    interceptResponseMatch: () => (interceptResExpr ? resPredicate : () => false),
  };
}
