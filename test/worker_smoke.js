// test/worker_smoke.js — WebEncryptor crypto_worker 冒烟测试 (node 运行)
// 用法: 先 npm install --no-save libsodium-sumo (仓库根目录), 然后:
//   node test/worker_smoke.js
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const messages = [];

// --- 模拟 Worker 环境 ---
globalThis.self = {
    postMessage: (m) => messages.push(m),
};
globalThis.importScripts = () => {
    if (!globalThis.sodium) {
        globalThis.sodium = require(path.join(REPO, 'htdocs', 'sodium.js'));
    }
};
if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto; // 保险: node<19
}

// --- 加载 worker ---
const workerSrc = fs.readFileSync(path.join(REPO, 'htdocs', 'crypto_worker.js'), 'utf8');
eval(workerSrc); // eslint-disable-line no-eval

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
    await self.onmessage({ data: payload });
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
    const RULE = 'my-vault-v2';
    const PATH = 'REDA0GREENB1BLUEC2BLACKD3REDE4';
    const PT = 'hello 世界 🔐 测试文本';

    console.log('== 加密/解密 ==');
    let t0 = Date.now();
    const enc = await runAction({ action: 'encrypt', plaintext: PT, password: PW, rulePhrase: RULE, path: PATH });
    const encMs = Date.now() - t0;
    check('加密成功', enc.status === 'success', JSON.stringify(enc).slice(0, 200));
    const ct = enc.result || '';
    check('格式为 WE1. 且 4 段', typeof ct === 'string' && ct.startsWith('WE1.') && ct.slice(4).split('.').length === 4, ct.slice(0, 40));
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
    r = await runAction({ action: 'decrypt', ciphertext: ct, password: PW, rulePhrase: 'different-phrase', path: PATH });
    check('错误规则短语被拒绝', r.status === 'error', r.error);
    r = await runAction({ action: 'decrypt', ciphertext: ct, password: PW, rulePhrase: RULE, path: 'REDB0GREENX1' });
    check('错误棋盘被拒绝', r.status === 'error', r.error);
    // 长度前缀歧义: rule='AB', path='C' 与 rule='A', path='BC' 必须产生不同密钥
    const encAB = await runAction({ action: 'encrypt', plaintext: 'x', password: PW, rulePhrase: 'AB', path: 'C' });
    r = await runAction({ action: 'decrypt', ciphertext: encAB.result, password: PW, rulePhrase: 'A', path: 'BC' });
    check('盐材料无拼接歧义 (AB/C ≠ A/BC)', r.status === 'error', r.error);
    // 篡改密文: 翻转密文段最后一个 base64 字符
    const parts = ct.slice(4).split('.');
    const tampered = 'WE1.' + parts[0] + '.' + parts[1] + '.' +
        parts[2].slice(0, -1) + (parts[2].endsWith('A') ? 'B' : 'A') + '.' + parts[3];
    r = await runAction({ action: 'decrypt', ciphertext: tampered, password: PW, rulePhrase: RULE, path: PATH });
    check('篡改密文被拒绝', r.status === 'error', r.error);
    // 旧格式 / 非法格式
    r = await runAction({ action: 'decrypt', ciphertext: 'aGVsbG8.d29ybGQ.bWFj', password: PW, rulePhrase: RULE, path: PATH });
    check('旧格式密文被明确拒绝', r.status === 'error' && /格式/.test(r.error), r.error);
    r = await runAction({ action: 'decrypt', ciphertext: ct, password: PW, rulePhrase: '', path: PATH });
    check('空规则短语被拒绝', r.status === 'error', r.error);
    r = await runAction({ action: 'encrypt', plaintext: 'x', password: PW, rulePhrase: RULE, path: '   ' });
    check('空白棋盘被拒绝', r.status === 'error', r.error);
    r = await runAction({ action: 'bogus' });
    check('未知动作报错', r.status === 'error', r.error);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败 (加密耗时约 ${encMs}ms)`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
    console.error('测试崩溃:', e);
    process.exit(1);
});
