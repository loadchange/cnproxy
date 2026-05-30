/**
 * AddonManager — ordered registry that dispatches lifecycle hooks to addons.
 * Addons run in registration order and a throwing addon is logged but does not abort the chain.
 */

import type { Addon, HookName } from "./types.ts";
import type { Flow, WebSocketMessage } from "../flow/flow.ts";
import { log } from "../logger.ts";

export class AddonManager {
  private chain: Addon[] = [];

  add(addon: Addon): void {
    this.chain.push(addon);
  }

  get(name: string): Addon | undefined {
    return this.chain.find((a) => a.name === name);
  }

  remove(name: string): void {
    this.chain = this.chain.filter((a) => a.name !== name);
  }

  /** True if any registered addon implements the given hook (used to decide if we can stream). */
  has(hook: HookName): boolean {
    return this.chain.some((a) => typeof a[hook] === "function");
  }

  async trigger(hook: HookName, flow: Flow, extra?: WebSocketMessage): Promise<void> {
    for (const addon of this.chain) {
      const fn = addon[hook] as ((f: Flow, e?: WebSocketMessage) => unknown) | undefined;
      if (typeof fn !== "function") continue;
      try {
        await fn.call(addon, flow, extra);
      } catch (err) {
        log.error(`addon "${addon.name}".${hook} threw:`, err);
      }
    }
  }

  async triggerLifecycle(hook: "running" | "done"): Promise<void> {
    for (const addon of this.chain) {
      const fn = addon[hook];
      if (typeof fn !== "function") continue;
      try {
        await fn.call(addon);
      } catch (err) {
        log.error(`addon "${addon.name}".${hook} threw:`, err);
      }
    }
  }
}
