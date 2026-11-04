// SPDX-License-Identifier: GPL-3.0-or-later
import { family } from "../modules/superagent/src/kv.ts";
const pending = family<any, [string]>("personal:inbox:");
const acknowledged = family<any, [string]>("personal:ack:");
// 入站先写数据库，模型暂未就绪或重启后继续投递；原型按Trigger id去重。
export class Inbox {
  private busy = false;
  private timer: any;
  private acknowledgements = new Map<string, Promise<void>>();
  constructor(
    private runtime: any,
    private report: (error: unknown) => void,
    private acknowledge?: (trigger: any) => Promise<void>,
  ) {}
  async receive(trigger: any) {
    this.runtime.store.set(pending(trigger.id), trigger);
    await this.ensureAcknowledged(trigger);
    await this.drain();
  }
  private async ensureAcknowledged(trigger: any) {
    if (!this.acknowledge || this.runtime.store.get(acknowledged(trigger.id)))
      return;
    const existing = this.acknowledgements.get(trigger.id);
    if (existing) return existing;
    const task = (async () => {
      await this.acknowledge!(trigger);
      this.runtime.store.set(acknowledged(trigger.id), {
        at: new Date().toISOString(),
      });
    })();
    this.acknowledgements.set(trigger.id, task);
    try {
      await task;
    } finally {
      this.acknowledgements.delete(trigger.id);
    }
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.runtime.ready;
      for (const key of this.runtime.store.keys(pending)) {
        const trigger = this.runtime.store.get(key);
        if (!trigger) continue;
        await this.ensureAcknowledged(trigger);
        this.runtime.receive(trigger);
        this.runtime.store.delete(key);
      }
    } finally {
      this.busy = false;
    }
  }
  start() {
    this.timer = setInterval(() => this.drain().catch(this.report), 3000);
    void this.drain().catch(this.report);
  }
  stop() {
    clearInterval(this.timer);
  }
}
