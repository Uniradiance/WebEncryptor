// test/recognition_test.mjs — 八方向链码识别: 稳健性回归 + JS/WASM 精确一致性(parity) + 性能.
// 用法: node test/recognition_test.mjs [--seeds=1,2,7] [--runs=1600]
// 说明: 用合成折线模拟"同一图案画很多遍" (随机平移/缩放/笔迹抖动/拐角倒角),
//       断言识别出的方向序列与意图完全一致; 同时以确定性种子跑多组, 检验
//       随机波动下的一致性; 然后对 JS 参考实现与 Rust/WASM 引擎做逐字段
//       一致性(parity)校验, 最后给出单次提取性能对比。
import * as REF from '../htdocs/signature_recognition.js';
import * as ENG from '../htdocs/recognition_engine.js';
import { runBattery, mulberry32, render, INTENT, INTENT_SEQ } from './lib/battery.mjs';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')); }
};

const argSeeds = (() => {
  const m = /--seeds=([\d,]+)/.exec(process.argv.join(' '));
  return m ? m[1].split(',').map(Number) : [1, 2, 7, 42, 555, 777, 2024];
})();

console.log('== 稳健性电池 (deterministic, seeds: ' + argSeeds.join(',') + ') ==');
for (const seed of argSeeds) {
  const r = runBattery(REF, { seed, verbose: false });
  check('battery(REF) seed=' + seed + ' -> ' + r.passed + ' checks', r.failed === 0,
    r.failures.slice(0, 4).join(' ; '));
}

console.log('== WASM 引擎电池 (同一算法, 同一阈值) ==');
await ENG.whenReady;
console.log('   engine status: ' + ENG.engineStatus());
if (ENG.engineStatus() === 'wasm') {
  for (const seed of argSeeds) {
    const r = runBattery(ENG, { seed, verbose: false });
    check('battery(WASM) seed=' + seed + ' -> ' + r.passed + ' checks', r.failed === 0,
      r.failures.slice(0, 4).join(' ; '));
  }

  // ---- JS <-> WASM exact parity (sequence / count / segment dir / rounded length) ----
  console.log('== JS <-> WASM 精确一致性 (parity, 1600 次随机输入) ==');
  const runs = Number((/--runs=(\d+)/.exec(process.argv.join(' ')) || [])[1] || 1600);
  const rng = mulberry32(1234);
  const savedRandom = Math.random;
  Math.random = rng;
  let parityFail = 0;
  const firstMismatch = [];
  for (let i = 0; i < runs; i++) {
    const pts = render(INTENT, { jitter: 0.3 + rng() * 1.6, scale: 0.75 + rng() * 0.5, ox: (rng() - 0.5) * 240, oy: (rng() - 0.5) * 80, cornerRadius: 2 + rng() * 6 });
    const a = REF.extractStrokeSegments(pts, REF.DEFAULTS);
    const b = ENG.extractStrokeSegments(pts, ENG.DEFAULTS);
    if (a.empty !== b.empty || a.sequence !== b.sequence || a.count !== b.count) {
      parityFail++;
      if (firstMismatch.length < 3) firstMismatch.push({ seqA: a.sequence, seqB: b.sequence, cntA: a.count, cntB: b.count });
      continue;
    }
    for (let k = 0; k < a.count; k++) {
      if (a.segments[k].dir !== b.segments[k].dir || a.segments[k].length !== b.segments[k].length) {
        parityFail++;
        if (firstMismatch.length < 3) firstMismatch.push({ k, a: a.segments[k], b: b.segments[k] });
        break;
      }
    }
  }
  Math.random = savedRandom;
  check('parity ' + runs + ' runs, 0 mismatch', parityFail === 0,
    firstMismatch.length ? JSON.stringify(firstMismatch) : parityFail + ' mismatches');

  // ---- 性能: 单个长笔画提取 ----
  console.log('== 性能 (JS 参考实现 vs WASM 引擎) ==');
  const big = [];
  let x = 0, y = 0;
  const leg = (dx, dy, len) => {
    const n = Math.round(len / 2);
    for (let i = 0; i < n; i++) {
      x += dx * 2; y += dy * 2;
      big.push({ x: x + (rng() - 0.5) * 1.6, y: y + (rng() - 0.5) * 1.6 });
    }
  };
  for (let k = 0; k < 4; k++) {
    leg(1, 0, 90); leg(0, -1, 70); leg(1, 0, 80); leg(0, 1, 70);
    leg(-1, 0, 85); leg(0, -1, 72); leg(1, 0, 84); leg(0, 1, 70);
    leg(1, 0, 78); leg(0, -1, 66); leg(-1, 0, 74); leg(0, 1, 68);
  }
  const sparse = [];
  for (let i = 0; i < big.length; i += 3) sparse.push(big[i]);
  const N = 100;
  let t0 = process.hrtime.bigint();
  let seqJs = '';
  for (let i = 0; i < N; i++) seqJs = REF.extractStrokeSegments(sparse, REF.DEFAULTS).sequence;
  const jsMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  t0 = process.hrtime.bigint();
  let seqWasm = '';
  for (let i = 0; i < N; i++) seqWasm = ENG.extractStrokeSegments(sparse, ENG.DEFAULTS).sequence;
  const wasmMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const expect = 'RURDLURDRULD'.repeat(4);
  check('perf seq correct', seqJs === expect && seqWasm === expect, seqJs.slice(0, 30) + ' vs ' + seqWasm.slice(0, 30));
  check('JS 参考实现 < 10ms (' + jsMs.toFixed(3) + ' ms, ' + sparse.length + ' pts)', jsMs < 10);
  check('WASM 引擎 < 10ms (' + wasmMs.toFixed(3) + ' ms)', wasmMs < 10);
  console.log('   JS ' + jsMs.toFixed(3) + ' ms/extract | WASM ' + wasmMs.toFixed(3) + ' ms/extract | speedup ' +
    (jsMs / wasmMs).toFixed(2) + 'x');
} else {
  check('wasm engine loaded', false, 'status=' + ENG.engineStatus());
}

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
