import assert from 'node:assert/strict';
import { PasswordService } from '../htdocs/password_service.js';

const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
};
const service = new PasswordService({ timeoutMs: 20 });
const maxCiphertextLength = 4 * Math.ceil(4 * 1024 * 1024 / 3) + 71;
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
let calls = 0;
let signal;
globalThis.fetch = async (_, options) => {
    calls++;
    signal = options.signal;
    return new Promise(() => {});
};
await assert.rejects(service.addPassword({ name: 'test', password: 'WE2.test' }), /timed out.*Refresh the list/);
assert.equal(calls, 1, 'unknown mutation must not be automatically retried');
assert.equal(signal.aborted, true, 'deadline must cancel the request');

// A server may send headers and then stall the JSON body indefinitely.
globalThis.fetch = async (_, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
};
await assert.rejects(service.getPasswords(), /timed out/);
assert.equal(signal.aborted, true);

globalThis.fetch = async () => json([{ id: 1, name: 'recovered' }]);
assert.equal((await service.getPasswords())[0].name, 'recovered', 'service must recover after timeout');

calls = 0;
globalThis.prompt = () => 'new-token';
globalThis.fetch = async (_, options) => {
    calls++;
    if (calls === 1) return new Response('', { status: 401 });
    assert.equal(options.headers['X-Auth-Token'], 'new-token');
    return json({ id: 2 });
};
assert.equal((await service.addPassword({ name: 'authorized' })).id, 2);
assert.equal(calls, 2, 'only an explicit 401 token retry is allowed');

calls = 0;
globalThis.fetch = async () => { calls++; return json({ id: 3 }); };
for (const data of [{ password: null }, { toString: 'unknown field' }, { name: '中'.repeat(1366) }, { password: 'A'.repeat(maxCiphertextLength + 1) }]) {
    await assert.rejects(service.addPassword(data));
}
assert.equal(calls, 0, 'invalid or oversized fields must fail before sending');
await service.addPassword({ name: 'A'.repeat(4096), description: 'x'.repeat(65536), password: 'A'.repeat(maxCiphertextLength) });
assert.equal(calls, 1, 'largest supported ciphertext must be saveable');

// Explicit cancellation propagates through the request boundary.
globalThis.fetch = (_, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
});
const controller = new AbortController();
const pending = service._fetch('/api/passwords', { signal: controller.signal });
controller.abort();
await assert.rejects(pending, /cancelled/);
console.log('Password service regression passed: header/body timeouts, abort, recovery, no blind retry, auth retry and UTF-8 capacity.');
