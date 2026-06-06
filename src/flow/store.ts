/**
 * In-memory flow store: a bounded ring buffer plus an event bus the web UI subscribes to.
 */

import { EventEmitter } from "node:events";
import type { Flow } from "./flow.ts";

export type FlowEvent = "add" | "update" | "intercept" | "clear";

export class FlowStore extends EventEmitter {
  private flows: Flow[] = [];
  private byId = new Map<string, Flow>();

  constructor(private max: number) {
    super();
    this.setMaxListeners(0);
  }

  setMax(max: number): void {
    this.max = max;
    this.trim();
  }

  add(flow: Flow): void {
    this.flows.push(flow);
    this.byId.set(flow.id, flow);
    this.trim();
    this.emit("add", flow);
  }

  /** Notify listeners that an existing flow changed (response arrived, ws message, etc). */
  update(flow: Flow, reason: FlowEvent = "update"): void {
    this.emit(reason, flow);
  }

  get(id: string): Flow | undefined {
    return this.byId.get(id);
  }

  list(): Flow[] {
    return this.flows;
  }

  clear(): void {
    this.flows = [];
    this.byId.clear();
    this.emit("clear");
  }

  /** Remove a single flow by ID. Returns true if found and removed. */
  remove(id: string): boolean {
    const idx = this.flows.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    this.flows.splice(idx, 1);
    this.byId.delete(id);
    this.emit("update", undefined as unknown as Flow);
    return true;
  }

  private trim(): void {
    while (this.flows.length > this.max) {
      const dropped = this.flows.shift();
      if (dropped) this.byId.delete(dropped.id);
    }
  }
}
