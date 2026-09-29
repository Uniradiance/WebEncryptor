// test/worker_smoke.js — WebEncryptor crypto_worker 冒烟测试 (node 运行)
// 用法 (零依赖，使用实际浏览器 sodium.js):
//   node test/worker_smoke.js
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const messages = [];

// Run the browser distribution in a Worker-like VM: no npm dependency and
// the exact sodium.js shipped to users (not a separate Node native package).
const vm = require('node:vm');
const context = vm.createContext({
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, WebAssembly,
    crypto: require('node:crypto').webcrypto, atob, btoa,
    setTimeout, clearTimeout, setInterval, clearInterval,
    self: { postMessage: m => messages.push(m) },
});
context.self.crypto = context.crypto;
context.importScripts = (...names) => names.forEach(name => vm.runInContext(
    fs.readFileSync(path.join(REPO, 'htdocs', name), 'utf8'), context));
vm.runInContext(fs.readFileSync(path.join(REPO, 'htdocs', 'crypto_worker.js'), 'utf8'), context);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitInit(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (messages.some(m => m.status === 'success' && m.action === 'worker_init_sodium_ready')) return;
        if (messages.some(m => m.status === 'error' && m.action === 'worker_init_sodium_failed')) {
            throw new Error('worker init failed');
        }
        await sleep(100);
    }
    throw new Error('worker init timeout');
}

async function runAction(payload) {
    const before = messages.length;
    await context.self.onmessage({ data: payload });
    const newMsgs = messages.slice(before);
    return newMsgs[newMsgs.length - 1];
}

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

(async () => {
    console.log('== 初始化 ==');
    await waitInit();
    check('worker_init_sodium_ready 已发出', true);

    const PW = 'Correct Horse Battery Staple!';
    const RULE = '02064026024';
    const PATH = 'REDA0GREENB1BLUEC2BLACKD3REDE4';
    const PT = 'hello 世界 🔐 测试文本';

    console.log('== 加密/解密 ==');
    let t0 = Date.now();
    const enc = await runAction({ action: 'encrypt', plaintext: PT, password: PW, rulePhrase: RULE, path: PATH });
    const encMs = Date.now() - t0;
    check('加密成功', enc.status === 'success', JSON.stringify(enc).slice(0, 200));
    const ct = enc.result || '';
    check('格式为 WE2. 且 4 段', typeof ct === 'string' && ct.startsWith('WE2.') && ct.slice(4).split('.').length === 4, ct.slice(0, 40));
    check('加密耗时合理', encMs < 60000, `${encMs}ms`);

    const dec = await runAction({ action: 'decrypt', ciphertext: ct, password: PW, rulePhrase: RULE, path: PATH });
    check('解密往返一致 (含中文/emoji)', dec.status === 'success' && dec.result === PT, dec.error || dec.result);

    const ver = await runAction({ action: 'verify', ciphertext: ct, password: PW, rulePhrase: RULE, path: PATH });
    check('verify 动作可用', ver.status === 'success' && ver.result === PT, ver.error);

    const enc2 = await runAction({ action: 'encrypt', plaintext: PT, password: PW, rulePhrase: RULE, path: PATH });
    check('同输入两次加密结果不同 (随机盐/IV)', enc2.status === 'success' && enc2.result !== ct);
    const dec2 = await runAction({ action: 'decrypt', ciphertext: enc2.result, password: PW, rulePhrase: RULE, path: PATH });
    check('第二份密文也能解密', dec2.status === 'success' && dec2.result === PT, dec2.error);

    console.log('== 错误路径 ==');
    let r = await runAction({ action: 'decrypt', ciphertext: ct, password: 'WRONG-password', rulePhrase: RULE, path: PATH });
    check('错误口令被拒绝', r.status === 'error', r.error);
    r = await runAction({ action: 'decrypt', ciphertext: ct, password: PW, rulePhrase: '1', path: PATH });
    check('错误规则短语被拒绝', r.status === 'error', r.error);
    r = await runAction({ action: 'decrypt', ciphertext: ct, password: PW, rulePhrase: RULE, path: 'REDB0GREENX1' });
    check('错误棋盘被拒绝', r.status === 'error', r.error);
    // 长度前缀歧义: rule='01', path='2X' 与 rule='0', path='12X' 必须产生不同密钥
    const encAB = await runAction({ action: 'encrypt', plaintext: 'x', password: PW, rulePhrase: '01', path: '2X' });
    r = await runAction({ action: 'decrypt', ciphertext: encAB.result, password: PW, rulePhrase: '0', path: '12X' });
    check('盐材料无拼接歧义 (01/2X ≠ 0/12X)', r.status === 'error', r.error);
    // 篡改密文: 翻转密文段最后一个 base64 字符
    const parts = ct.slice(4).split('.');
    const tampered = 'WE2.' + parts[0] + '.' + parts[1] + '.' +
        parts[2].slice(0, -1) + (parts[2].endsWith('A') ? 'B' : 'A') + '.' + parts[3];
    r = await runAction({ action: 'decrypt', ciphertext: tampered, password: PW, rulePhrase: RULE, path: PATH });
    check('篡改密文被拒绝', r.status === 'error', r.error);
    // 非法格式
    r = await runAction({ action: 'decrypt', ciphertext: 'aGVsbG8.d29ybGQ.bWFj', password: PW, rulePhrase: RULE, path: PATH });
    check('非法密文格式被拒绝', r.status === 'error' && /格式|format/.test(r.error), r.error);
    r = await runAction({ action: 'decrypt', ciphertext: ct, password: PW, rulePhrase: '', path: PATH });
    check('空规则短语被拒绝', r.status === 'error', r.error);
    r = await runAction({ action: 'encrypt', plaintext: 'x', password: PW, rulePhrase: RULE, path: '   ' });
    check('空白棋盘被拒绝', r.status === 'error', r.error);
    r = await runAction({ action: 'bogus' });
    check('未知动作报错', r.status === 'error', r.error);

    r = await runAction({ action: 'decrypt', ciphertext: ct.replace('WE2.', 'BAD.'), password: PW, rulePhrase: RULE, path: PATH });
    check('invalid ciphertext prefix rejected', r.status === 'error' && /format/.test(r.error));
    const cardinal = await runAction({ action: 'encrypt', requestId: 41, plaintext: 'two segments', password: PW, rulePhrase: '02', path: PATH });
    r = await runAction({ action: 'decrypt', requestId: 42, ciphertext: cardinal.result, password: PW, rulePhrase: '1', path: PATH });
    check('R followed by U is distinct from RU', r.status === 'error');
    check('request ID round-trips on success and failure', cardinal.requestId === 41 && r.requestId === 42);
    const before = messages.length;
    await Promise.all([
        context.self.onmessage({ data: { action: 'encrypt', requestId: 51, plaintext: 'first', password: PW, rulePhrase: RULE, path: PATH } }),
        context.self.onmessage({ data: { action: 'encrypt', requestId: 52, plaintext: 'second', password: PW, rulePhrase: RULE, path: PATH } }),
    ]);
    const batch = messages.slice(before);
    check('Worker serializes overlapping requests and progress', batch.map(m => m.requestId).join(',') === '51,51,51,52,52,52');

    console.log('== UTF-8 容量边界 ==');
    const maxPlaintextBytes = 4 * 1024 * 1024;
    const emojiBoundary = '🔐'.repeat(maxPlaintextBytes / 4);
    const boundaryEnc = await runAction({ action: 'encrypt', plaintext: emojiBoundary, password: PW, rulePhrase: RULE, path: PATH });
    check('4 MiB UTF-8 boundary encrypts including format overhead', boundaryEnc.status === 'success' && boundaryEnc.result.length === 4 * Math.ceil(maxPlaintextBytes / 3) + 71);
    r = await runAction({ action: 'decrypt', ciphertext: boundaryEnc.result, password: PW, rulePhrase: RULE, path: PATH });
    check('boundary emoji plaintext round-trips', r.status === 'success' && r.result === emojiBoundary);
    r = await runAction({ action: 'encrypt', plaintext: emojiBoundary + 'a', password: PW, rulePhrase: RULE, path: PATH });
    check('one UTF-8 byte over the limit is rejected', r.status === 'error' && /UTF-8/.test(r.error));
    r = await runAction({ action: 'encrypt', plaintext: '中'.repeat(2 * 1024 * 1024), password: PW, rulePhrase: RULE, path: PATH });
    check('oversized Chinese input is rejected before encryption', r.status === 'error' && /UTF-8/.test(r.error));
    r = await runAction({ action: 'decrypt', ciphertext: boundaryEnc.result + 'A', password: PW, rulePhrase: RULE, path: PATH });
    check('ciphertext one character over the limit is rejected', r.status === 'error' && /too long/.test(r.error));
    // Base64 rounds up: an over-limit byte array can have the same encoded
    // length as the boundary. Check decoded bytes too, before key derivation.
    const oversizedParts = boundaryEnc.result.split('.');
    oversizedParts[3] = Buffer.alloc(maxPlaintextBytes + 1).toString('base64');
    r = await runAction({ action: 'decrypt', ciphertext: oversizedParts.join('.'), password: PW, rulePhrase: RULE, path: PATH });
    check('decoded ciphertext over 4 MiB is rejected', r.status === 'error' && /field lengths/.test(r.error));
    for (const [field, value] of [['plaintext', 123], ['password', {}], ['path', ['REDA0']]]) {
        r = await runAction({ action: 'encrypt', plaintext: 'test', password: PW, rulePhrase: RULE, path: PATH, [field]: value });
        check(`non-string ${field} is rejected`, r.status === 'error' && /strings/.test(r.error));
    }

    console.log(`\n结果: ${passed} 通过, ${failed} 失败 (加密耗时约 ${encMs}ms)`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
    console.error('测试崩溃:', e);
    process.exit(1);
});
