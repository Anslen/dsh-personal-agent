// SPDX-License-Identifier: GPL-3.0-or-later
import { family } from "../modules/superagent/src/kv.ts";
const pending = family<any, [string]>("personal:inbox:");
// 入站先写数据库，模型暂未就绪或重启后继续投递；原型按Trigger id去重。
export class Inbox {
  private busy = false;
  private timer: any;
  constructor(
    private runtime: any,
    private report: (error: unknown) => void,
  ) {}
  async receive(trigger: any) {
    this.runtime.store.set(pending(trigger.id), trigger);
    await this.drain();
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.runtime.ready;
      for (const key of this.runtime.store.keys(pending)) {
        const trigger = this.runtime.store.get(key);
        if (!trigger) continue;
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
