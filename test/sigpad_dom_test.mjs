// 临时验证脚本: 用最小 DOM 仿真实测 SignaturePad 组件逻辑
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REC = require('../htdocs/signature_recognition.js');
globalThis.SignatureRecognition = REC;

// ---------- fake DOM ----------
const fakeCtx = {
  ops: [], strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
  setTransform(...a){ this.ops.push(['setTransform', a]); },
  clearRect(...a){ this.ops.push(['clearRect']); },
  beginPath(){ this.ops.push(['beginPath']); },
  moveTo(...a){ this.ops.push(['moveTo', a]); },
  lineTo(...a){ this.ops.push(['lineTo', a]); },
  stroke(){ this.ops.push(['stroke']); },
};
class ClassList {
  constructor(){ this.set = new Set(); }
  add(...cs){ cs.forEach(c => this.set.add(c)); }
  remove(...cs){ cs.forEach(c => this.set.delete(c)); }
  toggle(c, v){ if (v === undefined) v = !this.set.has(c); v ? this.set.add(c) : this.set.delete(c); return v; }
  contains(c){ return this.set.has(c); }
}
class FakeEl {
  constructor(tag, attrs = {}) {
    this.tagName = tag; this.attrs = attrs; this.children = []; this.parentEl = null;
    this.classList = new ClassList(); this.listeners = {}; this.style = {};
    this.hidden = false; this.disabled = false; this.textContent = '';
    this.clientWidth = 800; this.offsetWidth = 1;
    if ('hidden' in attrs) this.hidden = true;
    if ('disabled' in attrs) this.disabled = true;
    if (attrs.class) attrs.class.split(/\s+/).forEach(c => this.classList.add(c));
  }
  querySelector(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const walk = (n) => { for (const c of n.children) { if (cls ? c.classList.contains(cls) : c.tagName === sel) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this);
  }
  addEventListener(type, fn){ (this.listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}){ for (const fn of this.listeners[type] || []) fn({ ...ev, preventDefault(){} }); }
  setPointerCapture(){}
  getBoundingClientRect(){ return { left: 0, top: 0, width: this.clientWidth }; }
  getContext(){ return fakeCtx; }
  appendChild(c){ c.parentEl = this; this.children.push(c); return c; }
  set className(v){ this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className(){ return [...this.classList.set].join(' '); }
  set innerHTML(str){ parseHtml(str, this); }
}
function parseHtml(str, parent) {
  parent.children = [];
  const re = /<\s*([a-z-]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?\s*>|([^<]+)/g;
  let m; const stack = [parent];
  while ((m = re.exec(str))) {
    if (m[3] !== undefined) {
      const t = m[3].trim(); if (!t) continue;
      const txt = new FakeEl('#text'); txt.textContent = t; txt.children = [];
      stack[stack.length - 1].appendChild(txt);
      continue;
    }
    const [ , tag, attrsRaw ] = m;
    const attrs = {};
    const ar = /([a-z-]+)(?:="([^"]*)")?/g; let a;
    while ((a = ar.exec(attrsRaw))) attrs[a[1]] = a[2] || '';
    const el = new FakeEl(tag, attrs);
    stack[stack.length - 1].appendChild(el);
    const rest = str.slice(re.lastIndex);
    const closed = rest.startsWith('</' + tag + '>');
    const selfClosed = /\/>$/.test(m[0]);
    if (!closed && !selfClosed) stack.push(el);
  }
}

// 替换 window / rAF / timers
globalThis.window = { devicePixelRatio: 1, addEventListener(){} };
let rafCbs = [];
globalThis.requestAnimationFrame = (cb) => { rafCbs.push(cb); return rafCbs.length; };
let timers = [];
globalThis.setTimeout = (cb, ms) => { const t = { cb, ms, id: timers.length + 1 }; timers.push(t); return t.id; };
globalThis.clearTimeout = (id) => { timers = timers.filter(t => t.id !== id); };
const fireAllRaf = () => { const q = rafCbs; rafCbs = []; q.forEach(cb => cb()); };
const fireAllTimers = () => { const q = timers; timers = []; q.forEach(t => t.cb()); };
const pendingTimers = () => timers.map(t => t.ms);

// ---------- import the component ----------
const { createSignaturePad } = await import('../htdocs/SignaturePad.js');
const container = new FakeEl('div');
const pad = createSignaturePad(container, { minSegments: 2 });

const Q = (cls) => container.querySelector('.' + cls);
const canvas = Q('sigpad-canvas');
const feedback = Q('sigpad-feedback');
const undoBtn = Q('sigpad-undo');
const clearBtn = Q('sigpad-clear');
const confirmBtn = Q('sigpad-confirm');
const stamp = Q('sigpad-stamp');

let pass = 0, fail = 0;
const assert = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } };

// 模拟一笔: R→D→R 三段
function stroke(p1, p2, p3) {
  canvas.dispatch('pointerdown', { pointerId: 1, clientX: p1[0], clientY: p1[1] });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: (p1[0]+p2[0])/2, clientY: (p1[1]+p2[1])/2 });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: p2[0], clientY: p2[1] });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: (p2[0]+p3[0])/2, clientY: (p2[1]+p3[1])/2 });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: p3[0], clientY: p3[1] });
  fireAllRaf();
  canvas.dispatch('pointerup', { pointerId: 1 });
  fireAllRaf();
}

console.log('T1 初始状态');
assert('确认按钮初始禁用', confirmBtn.disabled === true);
assert('印章初始隐藏', stamp.hidden === true);
assert('画板未签名', pad.isSigned() === false);

console.log('T2 绘制有效图案');
stroke([10,50], [200,50], [200,120]);
assert('反馈栏显示箭头 (含箭头字符)', /[→←↑↓↗↘↙↖]/.test(feedback.textContent));
assert('反馈 ok 类', feedback.classList.contains('ok'));
assert('确认按钮已启用', confirmBtn.disabled === false);
assert('getSequence 非空', typeof pad.getSequence() === 'string' && pad.getSequence().length > 0);
assert('5 秒遮蔽计时已排定', pendingTimers().includes(5000));

console.log('T3 5 秒后自动遮蔽为固定 18 个 * 号');
fireAllTimers();
assert('反馈栏箭头已被 * 替换', !/[→←↑↓↗↘↙↖]/.test(feedback.textContent) && feedback.textContent.includes('*'));
assert('* 号数量固定为 18', (feedback.textContent.match(/\*/g) || []).length === 18);
assert('反馈 masked 类', feedback.classList.contains('masked'));

console.log('T4 新笔迹恢复箭头显示并重排计时');
stroke([10,150], [180,150], [180,80]);
assert('反馈箭头恢复', /[→←↑↓↗↘↙↖]/.test(feedback.textContent));
assert('反馈清除 masked 类', !feedback.classList.contains('masked'));
assert('计时器重新排定', pendingTimers().includes(5000));

console.log('T5 点击确认: 抹去笔迹 + 盖章');
fireAllTimers(); // 让 5 秒遮蔽先触发
assert('遮蔽已生效', feedback.classList.contains('masked'));
fakeCtx.ops.length = 0;
confirmBtn.dispatch('click');
assert('印章显示 (直接显示, 无 show 类)', stamp.hidden === false && !stamp.classList.contains('show'));
assert('画板标记 signed', container.querySelector('.sigpad').classList.contains('signed'));
assert('确认后不再绘制任何笔迹', !fakeCtx.ops.some(op => op[0] === 'moveTo' || op[0] === 'lineTo'));
assert('最后一次画布操作是 clearRect', fakeCtx.ops.at(-1)[0] === 'clearRect');
assert('反馈显示遮蔽的 18 个 * 号 (已签名不显示说明文字)', (feedback.textContent.match(/\*/g) || []).length === 18 && !feedback.textContent.includes('已签名'));
assert('反馈为 masked 类', feedback.classList.contains('masked'));
assert('确认按钮回到禁用', confirmBtn.disabled === true);
assert('撤回按钮禁用', undoBtn.disabled === true);
assert('清除按钮仍可用 (可撤销确认)', clearBtn.disabled === false);
assert('isSigned() = true', pad.isSigned() === true);
assert('序列仍可用 (加密因子封存)', typeof pad.getSequence() === 'string' && pad.getSequence().length > 0);

console.log('T6 确认后落笔被忽略');
const opsBefore = fakeCtx.ops.length;
canvas.dispatch('pointerdown', { pointerId: 2, clientX: 5, clientY: 5 });
canvas.dispatch('pointermove', { pointerId: 2, clientX: 100, clientY: 5 });
fireAllRaf();
canvas.dispatch('pointerup', { pointerId: 2 });
fireAllRaf();
assert('落笔未产生笔迹', fakeCtx.ops.slice(opsBefore).every(op => !['moveTo','lineTo'].includes(op[0])));
assert('画板保持签名状态', pad.isSigned() === true);

console.log('T7 清除重建');
clearBtn.dispatch('click');
assert('印章隐藏', stamp.hidden === true);
assert('signed 标记移除', !container.querySelector('.sigpad').classList.contains('signed'));
assert('isSigned() = false', pad.isSigned() === false);
assert('序列清空', pad.getSequence() === null);
assert('反馈回到默认提示', feedback.textContent.includes('每段画长一些'));

console.log('T8 未有效时确认按钮不可点 (画太短)');
stroke([10,50], [20,60], [30,60]);
assert('段数不足时不启用确认', confirmBtn.disabled === true);
assert('反馈为错误类', feedback.classList.contains('err') && !feedback.classList.contains('ok'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
