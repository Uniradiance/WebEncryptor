// A dedicated Worker contains the active key. Termination also cancels KDFs
// and outstanding requests; late replies cannot restore a locked session.
export class VaultClient {
    constructor(workerFactory = () => new Worker('./crypto_worker.js')) {
        this.workerFactory = workerFactory;
        this.serial = 0;
        this.pending = new Map();
        this.worker = null;
    }
    start() {
        if (this.worker) return;
        const worker = this.workerFactory();
        this.worker = worker;
        worker.onmessage = ({ data }) => {
            if (this.worker !== worker) return;
            if (data.action === 'worker_init_sodium_failed') { this.lock(new Error(data.error)); return; }
            if (data.status === 'progress' || data.action === 'worker_init_sodium_ready') return;
            const request = this.pending.get(data.requestId);
            if (!request) return;
            this.pending.delete(data.requestId);
            clearTimeout(request.timer);
            if (data.status === 'success') request.resolve(data.result);
            else request.reject(new Error(data.error));
        };
        worker.onerror = () => {
            if (this.worker === worker) this.lock(new Error('Vault worker failed. Unlock the vault again.'));
        };
    }
    request(action, data = {}) {
        this.start();
        const requestId = ++this.serial;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.lock(new Error('Vault operation timed out. Unlock the vault again.')), 60000);
            this.pending.set(requestId, { resolve, reject, timer });
            try { this.worker.postMessage({ ...data, action, requestId }); }
            catch (error) { this.lock(error); }
        });
    }
    lock(error = new Error('Vault locked.')) {
        this.worker?.terminate();
        this.worker = null;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
    }
}
