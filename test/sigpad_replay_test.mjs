// test/sigpad_replay_test.mjs — SignaturePad 状态一致性回归测试 (node, 零依赖).
//
// 用 DOM/Canvas stub 驱动真实的 htdocs/SignaturePad.js, 断言:
//   T1 每次落笔后离屏缓存恰好追加一份 ink, 反馈段数 = 各笔提取段数之和;
//   T2 画 N 笔撤 N 次, 恰好第 N 次同时"反馈归零"与"撤销按钮禁用" (无 0/-1 偏移);
//   T3 提取异常注入 (options.recognizer): 提交失败被自愈, 序列不丢段,
//      下一笔不消失, 撤销步进一致;
//   T4 识别引擎对异常/非有限输入永不抛异常, 规范化为 EMPTY; 正常输入不受影响。
// 用法: node test/sigpad_replay_test.mjs
import { pathToFileURL } from 'node:url';
import * as ENG from '../htdocs/recognition_engine.js';
await ENG.whenReady;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')); }
};

// ---------------------------------------------------------------------------
// DOM/Canvas stubs
// ---------------------------------------------------------------------------
const state = {
  offInk: 0, // polyline stroke() calls on offscreen contexts (each = one committed stroke ink)
  mainInk: 0, // stroke() calls on the visible canvas context
  rafQ: [],
};

function makeCtx(tag) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'canvas') return null;
      return (..._args) => {
        if (prop === 'stroke') {
          if (tag === 'off') state.offInk++;
          else state.mainInk++;
        }
      };
    },
  });
}

function makeEl(name) {
  const handlers = {};
  return {
    __name: name,
    width: 0, height: 0, style: {}, hidden: false, disabled: false, title: '',
    textContent: '', className: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener() {},
    fire(type, ev) {
      for (const h of (handlers[type] || [])) h(Object.assign({ type, preventDefault() {}, stopPropagation() {} }, ev));
    },
    click() { if (!this.disabled) this.fire('click', {}); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 758, height: 195 }; },
    get clientWidth() { return 758; },
    getContext: () => makeCtx('off'),
    setPointerCapture() {}, releasePointerCapture() {},
  };
}

globalThis.document = { createElement: () => makeEl('canvas') };
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
globalThis.requestAnimationFrame = (fn) => { state.rafQ.push(fn); return state.rafQ.length; };
globalThis.ResizeObserver = undefined;

const flush = () => { while (state.rafQ.length) { const f = state.rafQ.shift(); f(); } };

const { createSignaturePad } = await import(
  new URL('../htdocs/SignaturePad.js', import.meta.url).href + '?replay=' + Date.now()
);

function buildPad(opts = {}) {
  state.offInk = 0; state.mainInk = 0; state.rafQ.length = 0;
  const canvas = makeEl('canvas');
  canvas.getContext = () => makeCtx('main');
  const els = {
    '.sigpad': makeEl('sigpad'),
    '.sigpad-canvas': canvas,
    '.sigpad-stamp': makeEl('stamp'),
    '.sigpad-feedback': makeEl('feedback'),
    '.sigpad-undo': makeEl('undo'),
    '.sigpad-clear': makeEl('clear'),
    '.sigpad-confirm': makeEl('confirm'),
    '.sigpad-verify': makeEl('verify'),
    '.sigpad-cancel-verify': makeEl('cancelVerify'),
    '.sigpad-directions-toggle': makeEl('eye'),
  };
  const container = {
    innerHTML: '',
    clientWidth: 758,
    querySelector: (s) => els[s],
    getBoundingClientRect() { return { left: 0, top: 0, width: 758, height: 195 }; },
  };
  const pad = createSignaturePad(container, opts);
  flush();
  return { pad, canvas, els };
}

function drawStroke(canvas, x0, y0, pts) {
  canvas.fire('pointerdown', { clientX: x0, clientY: y0, pointerId: 1 });
  for (const [x, y] of pts) canvas.fire('pointermove', { clientX: x, clientY: y, pointerId: 1 });
  const [lx, ly] = pts.length ? pts[pts.length - 1] : [x0, y0];
  canvas.fire('pointerup', { clientX: lx, clientY: ly, pointerId: 1 });
  flush();
}

const lineTo = (x0, y0, x1, y1, step = 4) => {
  const pts = [];
  const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / step);
  for (let i = 1; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  return pts;
};

const segCount = (pad) => {
  const m = /\((\d+) segments\)/.exec(pad.getStatus());
  return m ? Number(m[1]) : -1;
};

// ---------------------------------------------------------------------------
// T1: consistency — offscreen cache and feedback track every committed stroke
// ---------------------------------------------------------------------------
console.log('== T1: 提交一致性 (offscreen ink == strokes; feedback == segments) ==');
{
  const { pad, canvas, els } = buildPad();
  els['.sigpad-directions-toggle'].fire('click', {}); // eye on: arrows on offscreen too
  check('T1 empty pad: no offscreen ink', state.offInk === 0, 'offInk=' + state.offInk);
  let ok = true;
  for (let k = 0; k < 9; k++) {
    if (k < 5) {
      drawStroke(canvas, 40, 30 + k * 18, lineTo(40, 30 + k * 18, 240, 30 + k * 18)); // R
    } else {
      drawStroke(canvas, 80 + (k - 5) * 60, 20, lineTo(80 + (k - 5) * 60, 20, 80 + (k - 5) * 60, 140)); // D
    }
    if (state.offInk !== k + 1 || segCount(pad) !== k + 1) { ok = false; break; }
  }
  check('T1 offscreen ink == 9 strokes', state.offInk === 9, 'offInk=' + state.offInk);
  check('T1 feedback segments == 9', segCount(pad) === 9, pad.getStatus());
  check('T1 sequence length == 9', !!pad.getSequence() && pad.getSequence().length === 9, pad.getSequence());
  check('T1 undo enabled with strokes', els['.sigpad-undo'].disabled === false);
  check('T1 per-stroke sync (ink & segments after every stroke)', ok);
}

// ---------------------------------------------------------------------------
// T2: undo to zero — exactly N undos empty both the feedback and the canvas
// ---------------------------------------------------------------------------
console.log('== T2: 撤销到零恰好清空 (无 0/-1 偏移) ==');
{
  const { pad, canvas, els } = buildPad();
  for (let k = 0; k < 5; k++) drawStroke(canvas, 40 + k * 30, 40, lineTo(40 + k * 30, 40, 40 + k * 30 + 150, 40));
  check('T2 five strokes -> 5 segments', segCount(pad) === 5, pad.getStatus());
  for (let k = 0; k < 5; k++) {
    els['.sigpad-undo'].click();
    const remaining = 4 - k;
    if (remaining > 0) {
      if (segCount(pad) !== remaining || els['.sigpad-undo'].disabled) {
        check('T2 undo #' + (k + 1) + ' leaves ' + remaining + ' segments', false, pad.getStatus());
        break;
      }
    }
  }
  check('T2 after 5 undos: feedback empty state', pad.getStatus() === 'Draw your pattern on the pad first.', pad.getStatus());
  check('T2 after 5 undos: undo button disabled', els['.sigpad-undo'].disabled === true);
  // a 6th undo must be a harmless no-op (no negative state)
  els['.sigpad-undo'].click();
  check('T2 6th undo is a no-op (still empty)', pad.getStatus() === 'Draw your pattern on the pad first.' && els['.sigpad-undo'].disabled === true);
}

// ---------------------------------------------------------------------------
// T3: extraction failure injection — transient commit failure is self-healed
// ---------------------------------------------------------------------------
console.log('== T3: 提取异常注入 (提交失败自愈, 无幽灵笔画) ==');
for (const variant of ['first stroke fails', 'last stroke fails']) {
  const failOn = variant === 'first stroke fails' ? 1 : 5;
  const realRec = ENG.createIncrementalRecognizer({ minSegments: 1 });
  let calls = 0;
  const wrapped = {
    addStroke(s) {
      calls++;
      if (calls === failOn) throw new Error('injected transient extraction failure');
      return realRec.addStroke(s);
    },
    removeLast: () => realRec.removeLast(),
    clear: () => realRec.clear(),
    result: (p) => realRec.result(p),
    get strokeCount() { return realRec.strokeCount; },
  };
  const { pad, canvas, els } = buildPad({ recognizer: () => wrapped });
  for (let k = 0; k < 5; k++) drawStroke(canvas, 40 + k * 30, 40, lineTo(40 + k * 30, 40, 40 + k * 30 + 150, 40));
  check('T3 [' + variant + '] all 5 strokes stay on canvas (no phantom vanish)', state.offInk === 5, 'offInk=' + state.offInk);
  check('T3 [' + variant + '] sequence healed to 5 segments', segCount(pad) === 5, pad.getStatus());
  check('T3 [' + variant + '] sequence length 5', !!pad.getSequence() && pad.getSequence().length === 5, pad.getSequence());
  for (let k = 0; k < 5; k++) els['.sigpad-undo'].click();
  check('T3 [' + variant + '] 5 undos empty the pad exactly', pad.getStatus() === 'Draw your pattern on the pad first.' && els['.sigpad-undo'].disabled === true);
}

// ---------------------------------------------------------------------------
// T4: engine defense — never throws on abnormal input; normal input unchanged
// ---------------------------------------------------------------------------
console.log('== T4: 引擎防御 (非有限/异常输入 -> EMPTY, 永不抛异常) ==');
{
  let threw = false;
  let r = null;
  try { r = ENG.extractStrokeSegments([{ x: 0, y: 0 }, { x: 100, y: NaN }], ENG.DEFAULTS); } catch (_e) { threw = true; }
  check('T4 NaN input: no throw + EMPTY', !threw && !!r && r.count === 0 && r.empty === true, JSON.stringify(r));

  threw = false;
  try { r = ENG.extractStrokeSegments([{ x: 0, y: 0 }, { x: Infinity, y: 0 }], ENG.DEFAULTS); } catch (_e) { threw = true; }
  check('T4 Infinity input: no throw + EMPTY', !threw && !!r && r.count === 0, JSON.stringify(r));

  threw = false;
  try { r = ENG.extractStrokeSegments(null, ENG.DEFAULTS); } catch (_e) { threw = true; }
  check('T4 null input: no throw + EMPTY', !threw && !!r && r.count === 0);

  threw = false;
  try { r = ENG.extractStrokeSegments([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], ENG.DEFAULTS); } catch (_e) { threw = true; }
  check('T4 tiny stroke: no throw + EMPTY', !threw && !!r && r.count === 0);

  const r2 = ENG.extractStrokeSegments([{ x: 0, y: 0 }, { x: 100, y: 0 }], ENG.DEFAULTS);
  check('T4 2-pt straight line still extracts R', r2.count === 1 && r2.sequence === 'R', r2.sequence);

  // many poisoned strokes, then a normal one: engine stays healthy
  const rec = ENG.createIncrementalRecognizer({ minSegments: 1 });
  for (let i = 0; i < 50; i++) rec.addStroke([{ x: i, y: NaN }, { x: i + 100, y: 0 }]);
  rec.addStroke([{ x: 0, y: 0 }, { x: 120, y: 0 }]);
  const rr = rec.result();
  check('T4 recognizer healthy after 50 poisoned strokes', rr.count === 1 && rr.sequence === 'R', rr.message);
}

// T5: verification compares segment codes, clears stale verification, and
// keeps the first drawing private while the second is entered.
console.log('== T5: 重画验证 ==');
{
  const { pad, canvas, els } = buildPad();
  drawStroke(canvas, 20, 40, lineTo(20, 40, 140, 40));
  const first = pad.getSequence();
  check('T5 first drawing is not verified', !pad.isVerified());
  els['.sigpad-verify'].click();
  check('T5 verification clears first ink and blocks using partial redraw', pad.getSequence() === null && !pad.isVerified());
  drawStroke(canvas, 20, 40, lineTo(20, 40, 20, 160));
  els['.sigpad-verify'].click();
  check('T5 different redraw cannot verify', !pad.isVerified() && pad.getSequence() === null);
  els['.sigpad-clear'].click();
  drawStroke(canvas, 50, 70, lineTo(50, 70, 220, 70));
  els['.sigpad-verify'].click();
  check('T5 translated/scaled matching redraw verifies', pad.isVerified() && pad.getSequence() === first && pad.isSigned());
  drawStroke(canvas, 20, 40, lineTo(20, 40, 20, 160));
  check('T5 verified pattern cannot be extended', pad.isVerified() && pad.getSequence() === first);
  pad.setLocked(true);
  pad.clear();
  check('T5 locked clear cannot change verified factor', pad.isVerified() && pad.getSequence() === first);
  pad.setLocked(false);
  pad.clear();
  check('T5 clear invalidates verification', !pad.isVerified() && pad.getSequence() === null);
  drawStroke(canvas, 20, 40, lineTo(20, 40, 140, 40));
  els['.sigpad-verify'].click();
  els['.sigpad-cancel-verify'].click();
  check('T5 cancellation discards both drawings', pad.getSequence() === null && !pad.isVerified());
}

// T6: corrected points reach recognition, coalesced samples and pen-up are
// retained, other pointers are ignored, and assistance resets between strokes.
console.log('== T6: 软吸附接入 ==');
{
  const committed = [];
  const { pad, canvas } = buildPad({ recognizer(options) {
    const real = ENG.createIncrementalRecognizer(options);
    return { ...real, addStroke(points) {
      committed.push(points.map(p => ({ ...p })));
      return real.addStroke(points);
    } };
  } });
  canvas.fire('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 });
  canvas.fire('pointermove', { clientX: 400, clientY: 100, pointerId: 2 });
  canvas.fire('pointerup', { clientX: 400, clientY: 100, pointerId: 2 });
  check('T6 other pointer cannot end the stroke', committed.length === 0);
  canvas.fire('pointermove', {
    clientX: 90, clientY: 18, pointerId: 1,
    getCoalescedEvents: () => [10, 30, 60].map(x => ({ clientX: x, clientY: x * 0.2 })),
  });
  canvas.fire('pointerup', { clientX: 100, clientY: 20, pointerId: 1 });
  flush();
  const stroke = committed[0];
  check('T6 coalesced samples and final point retained', stroke.length === 6 && stroke.at(-1).x === 100);
  check('T6 recognition receives softly corrected ink', stroke.at(-1).y < 20 && stroke.at(-1).y >= 16);
  drawStroke(canvas, 20, 40, lineTo(20, 40, 120, 40));
  check('T6 next stroke starts with zero correction', committed[1].every(p => p.y === 40));
  pad.clear();
  canvas.fire('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 });
  canvas.fire('pointermove', { clientX: 80, clientY: 0, pointerId: 1 });
  canvas.fire('pointercancel', { clientX: 0, clientY: 0, pointerId: 1 });
  check('T6 cancellation does not append a spurious endpoint', committed.at(-1).at(-1).x === 80);
  pad.clear();
}

// ---------------------------------------------------------------------------
console.log('== 结果: ' + passed + ' passed, ' + failed + ' failed ==');
process.exit(failed === 0 ? 0 : 1);
