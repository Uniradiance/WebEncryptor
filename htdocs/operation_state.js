export class OperationState {
  ready = false;
  active = null;
  saving = false;
  serial = 0;
  get busy() { return this.active !== null || this.saving; }
  begin(action, origin = 'crypto') {
    if (!this.ready || this.busy) return null;
    this.active = { requestId: ++this.serial, action, origin };
    return this.active;
  }
  accepts(message) {
    return this.active !== null && message.requestId === this.active.requestId &&
      message.action === this.active.action;
  }
  finish() {
    const job = this.active;
    this.active = null;
    return job;
  }
}
