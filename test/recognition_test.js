// test/recognition_test.js — 八方向链码识别稳健性测试 (node)
// 用合成折线模拟"同一图案画很多遍": 随机平移、缩放、笔迹抖动、拐角倒角,
// 断言每次识别出的方向序列与意图完全一致。
'use strict';
const { recognizeSequence, recognizeStrokes, extractStrokeSegments, classifyDir, DEFAULTS, createIncrementalRecognizer } = require('../htdocs/signature_recognition.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 单位向量 (对角方向归一化, 否则合成圆角半径被 √2 放大, 拐角区域宽于支撑臂,
// 45° 转折会被稀释成十几度)
const V = {
    R: [1, 0], L: [-1, 0], U: [0, -1], D: [0, 1],
    RU: [Math.SQRT1_2, -Math.SQRT1_2], RD: [Math.SQRT1_2, Math.SQRT1_2],
    LD: [-Math.SQRT1_2, Math.SQRT1_2], LU: [-Math.SQRT1_2, -Math.SQRT1_2],
};

/**
 * 渲染意图折线 segments = [{dir, length}, ...]
 * opts: jitter(逐点噪声σ), scale, ox/oy(平移), cornerRadius(拐角圆弧半径, 模拟真实手写圆角),
 *       step(采样步长)
 */
function render(segs, opts = {}) {
    const { jitter = 1.5, scale = 1, ox = 0, oy = 0, cornerRadius = 5, step = 2 } = opts;
    const pts = [];
    let x = ox, y = oy;
    pts.push({ x, y });
    let prev = null;
    const push = (px, py) => pts.push({ x: px + gauss() * jitter, y: py + gauss() * jitter });
    for (const seg of segs) {
        const [vx, vy] = V[seg.dir];
        if (prev && cornerRadius > 0) {
            // 90° 圆角: 圆心 C = P − r·u_prev + r·u_new, 弧从 S = P − r·u_prev 到 E = P + r·u_new
            const [px, py] = V[prev];
            const r = cornerRadius * scale;
            const S = { x: x - px * r, y: y - py * r };
            const E = { x: x + vx * r, y: y + vy * r };
            const C = { x: x - px * r + vx * r, y: y - py * r + vy * r };
            let a0 = Math.atan2(S.y - C.y, S.x - C.x);
            let a1 = Math.atan2(E.y - C.y, E.x - C.x);
            let d = a1 - a0; // 短弧 (|d| = π/2)
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            const n = Math.max(1, Math.ceil(Math.abs(d) * r / step));
            for (let k = 1; k <= n; k++) {
                const a = a0 + d * k / n;
                push(C.x + r * Math.cos(a), C.y + r * Math.sin(a));
            }
        }
        let remaining = seg.length * scale;
        while (remaining > 0) {
            const s = Math.min(step, remaining);
            x += vx * s; y += vy * s;
            remaining -= s;
            push(x, y);
        }
        prev = seg.dir;
    }
    return pts;
}

// 意图图案 (真实尺度): 12 段台阶式折线, 最短段 42px
// (转折腿长系数 2.0 下, 单笔内段长需 ≥ ~4% 笔画总长; 42px 在 ~580px 总长中占 7%)
const INTENT = [
    { dir: 'R', length: 58 }, { dir: 'U', length: 42 }, { dir: 'R', length: 50 },
    { dir: 'D', length: 44 }, { dir: 'L', length: 54 }, { dir: 'U', length: 46 },
    { dir: 'R', length: 56 }, { dir: 'D', length: 46 }, { dir: 'R', length: 52 },
    { dir: 'U', length: 42 }, { dir: 'L', length: 50 }, { dir: 'D', length: 44 },
];
const INTENT_SEQ = INTENT.map(s => s.dir).join('');

console.log('== 稳健性: 现实抖动 (σ≤1.5) 随机变化 300 次, 须 100% ==');
let mismatches = [];
for (let i = 0; i < 300; i++) {
    const pts = render(INTENT, {
        jitter: 0.5 + Math.random() * 1.0,          // 抖动 0.5~1.5px (真实笔迹水平)
        scale: 0.8 + Math.random() * 0.4,           // 缩放 0.8~1.2
        ox: (Math.random() - 0.5) * 200,            // 平移 ±100px
        oy: (Math.random() - 0.5) * 60,
    });
    const r = recognizeSequence(pts);
    if (!r.valid || r.sequence !== INTENT_SEQ) {
        mismatches.push({ i, valid: r.valid, seq: r.sequence, msg: r.message });
    }
}
check('300 次现实抖动变化全部识别一致', mismatches.length === 0,
    `失败 ${mismatches.length} 次: ${JSON.stringify(mismatches.slice(0, 3))}`);

console.log('== 稳健性: 极端压力 (σ≤2.4) 随机变化 300 次, 须 ≥99% ==');
let stressFails = [];
for (let i = 0; i < 300; i++) {
    const pts = render(INTENT, {
        jitter: 1.6 + Math.random() * 0.8,          // 抖动 1.6~2.4px (超出真实笔迹)
        scale: 0.8 + Math.random() * 0.4,
        ox: (Math.random() - 0.5) * 200,
        oy: (Math.random() - 0.5) * 60,
    });
    const r = recognizeSequence(pts);
    if (!r.valid || r.sequence !== INTENT_SEQ) {
        stressFails.push({ i, valid: r.valid, seq: r.sequence, msg: r.message });
    }
}
check(`极端压力一致率 ${300 - stressFails.length}/300 (≥99%)`, stressFails.length <= 3,
    `失败 ${stressFails.length} 次: ${JSON.stringify(stressFails.slice(0, 3))}`);

console.log('== 压力: 最短段 32px (现实下限, 200 次, 应 ≥90%) ==');
const INTENT_SHORT = [
    { dir: 'R', length: 44 }, { dir: 'U', length: 32 }, { dir: 'R', length: 36 },
    { dir: 'D', length: 32 }, { dir: 'L', length: 40 }, { dir: 'U', length: 34 },
    { dir: 'R', length: 42 }, { dir: 'D', length: 36 }, { dir: 'R', length: 34 },
    { dir: 'U', length: 32 }, { dir: 'L', length: 38 }, { dir: 'D', length: 34 },
];
const INTENT_SHORT_SEQ = INTENT_SHORT.map(s => s.dir).join('');
let shortOk = 0;
for (let i = 0; i < 200; i++) {
    const pts = render(INTENT_SHORT, { jitter: 1.5, scale: 0.9 + Math.random() * 0.3 });
    const r = recognizeSequence(pts);
    if (r.valid && r.sequence === INTENT_SHORT_SEQ) shortOk++;
}
check(`压力测试一致率 ${shortOk}/200 (${(100 * shortOk / 200).toFixed(0)}%)`, shortOk >= 180,
    '低于 90%: 建议用户每段画得更长');

// 信息项: 32px 段 @ 缩小 0.85 (超出舒适区, 只报告不判定)
{
    const INTENT_18 = [
        { dir: 'R', length: 44 }, { dir: 'U', length: 32 }, { dir: 'R', length: 38 },
        { dir: 'D', length: 32 }, { dir: 'L', length: 40 }, { dir: 'U', length: 34 },
        { dir: 'R', length: 42 }, { dir: 'D', length: 34 }, { dir: 'R', length: 38 },
        { dir: 'U', length: 32 }, { dir: 'L', length: 36 }, { dir: 'D', length: 34 },
    ];
    const SEQ = INTENT_18.map(s => s.dir).join('');
    let ok = 0;
    for (let i = 0; i < 100; i++) {
        const pts = render(INTENT_18, { jitter: 1.5, scale: 0.85 });
        const r = recognizeSequence(pts);
        if (r.valid && r.sequence === SEQ) ok++;
    }
    console.log(`  ℹ️  边界信息: 32px 段 @ 缩小0.85 → 一致率 ${ok}/100 (${ok}%) (低于此的段不可靠)`);
}

console.log('== 平移/缩放不变性 ==');
const rBase = recognizeSequence(render(INTENT, { jitter: 0.5, scale: 1, ox: 0, oy: 0 }));
const rShift = recognizeSequence(render(INTENT, { jitter: 0.5, scale: 1, ox: 173, oy: -42 }));
const rScale = recognizeSequence(render(INTENT, { jitter: 0.5, scale: 1.25, ox: 0, oy: 0 }));
check('基准识别有效', rBase.valid && rBase.sequence === INTENT_SEQ, rBase.message);
check('平移 ±173px 后序列不变', rShift.valid && rShift.sequence === INTENT_SEQ, rShift.message);
check('放大 1.25 倍后序列不变', rScale.valid && rScale.sequence === INTENT_SEQ, rScale.message);

console.log('== 多笔画累积 ==');

// 三段笔画拼接: 每段 4 段, 合计 12 段 (单笔画都不足 10 段, 必须靠累积)
{
    const stroke1 = render([
        { dir: 'R', length: 46 }, { dir: 'U', length: 36 }, { dir: 'R', length: 40 }, { dir: 'D', length: 38 },
    ], { jitter: 1.0, ox: 10, oy: 40 });
    const stroke2 = render([
        { dir: 'L', length: 42 }, { dir: 'U', length: 36 }, { dir: 'R', length: 44 }, { dir: 'D', length: 38 },
    ], { jitter: 1.0, ox: 120, oy: 80 });
    const stroke3 = render([
        { dir: 'R', length: 40 }, { dir: 'U', length: 36 }, { dir: 'L', length: 42 }, { dir: 'D', length: 38 },
    ], { jitter: 1.0, ox: 200, oy: 20 });
    const r = recognizeStrokes([stroke1, stroke2, stroke3]);
    check('三段笔画累积识别 (12 段 = 4+4+4)', r.valid && r.sequence === 'RURDLURDRULD' && r.count === 12, r.message);
}
// 抬笔跳越: 笔画 A 终点 (100,20), 笔画 B 起点 (400,90) — 跳越呈 13° 斜线, 不得产生幻影段
{
    const strokeA = render([
        { dir: 'R', length: 52 }, { dir: 'U', length: 40 }, { dir: 'R', length: 46 }, { dir: 'U', length: 36 },
        { dir: 'R', length: 44 }, { dir: 'U', length: 38 },
    ], { jitter: 0.8, ox: 0, oy: 100 });
    const strokeB = render([
        { dir: 'R', length: 50 }, { dir: 'D', length: 40 }, { dir: 'R', length: 44 }, { dir: 'D', length: 38 },
        { dir: 'R', length: 42 }, { dir: 'U', length: 40 },
    ], { jitter: 0.8, ox: 400, oy: 90 });
    const r = recognizeStrokes([strokeA, strokeB]);
    check('抬笔跳越不产生幻影段', r.valid && r.sequence === 'RURURURDRDRU' && r.count === 12,
        `${r.message} seq=${r.sequence}`);
}
// 笔画顺序敏感: 交换两笔顺序 → 序列不同
{
    const s1 = render([{ dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }], { jitter: 0.5 });
    const s2 = render([{ dir: 'L', length: 40 }, { dir: 'D', length: 40 }, { dir: 'L', length: 40 }, { dir: 'D', length: 40 }, { dir: 'L', length: 40 }, { dir: 'D', length: 40 }], { jitter: 0.5 });
    const r1 = recognizeStrokes([s1, s2]);
    const r2 = recognizeStrokes([s2, s1]);
    check('笔画顺序影响序列 (顺序是记忆的一部分)',
        r1.valid && r2.valid && r1.sequence === 'RURURULDLDLD' && r2.sequence === 'LDLDLDRURURU',
        `${r1.sequence} vs ${r2.sequence}`);
}
// 空笔画 / 无效小点忽略
{
    const s1 = render(INTENT, { jitter: 0.5 });
    const r = recognizeStrokes([s1, [], [{ x: 5, y: 5 }]]);
    check('空笔画与单点笔画被忽略', r.valid && r.sequence === INTENT_SEQ, r.message);
}

console.log('== 转折腿长门槛: 手抖 ">" 被过滤, 有意 "へ" 被保留 ==');
// 手抖 ">": 长横线中间一个短促的 V 形凸起 (两腿 ~11px, 45°), 应被当作噪声合并掉
{
    const pts = [];
    let x = 0, y = 0;
    pts.push({ x, y });
    for (let i = 0; i < 30; i++) { x += 2; pts.push({ x, y }); }         // R 60
    for (let i = 0; i < 4; i++) { x += 2; y -= 2; pts.push({ x, y }); }  // 凸起右上 (45°)
    for (let i = 0; i < 4; i++) { x += 2; y += 2; pts.push({ x, y }); }  // 凸起右下 (45°)
    for (let i = 0; i < 42; i++) { x += 2; pts.push({ x, y }); }         // R 84
    const r = extractStrokeSegments(pts, require('../htdocs/signature_recognition.js').DEFAULTS);
    check('手抖 ">" 凸起被过滤并合并 (1 段 R)', r.sequence === 'R' && r.count === 1, `${r.sequence} (${r.count} 段)`);
}
// 长线条尾部漂移 (转折门槛逐段增长): 长横线末尾一小截 37° 斜尾 (短于位置门槛),
// 应被吸收为一段 R; 尾巴足够长时则如实识别为转折 — 解析不再"局部/整体摆动"
{
    const tail = (steps) => {
        const pts = [];
        let x = 0, y = 0;
        pts.push({ x, y });
        for (let i = 0; i < 90; i++) { x += 2; pts.push({ x, y }); }          // R 180
        for (let i = 0; i < steps; i++) { x += 2; y -= 1.5; pts.push({ x, y }); } // 37° 尾
        return pts;
    };
    const rShort = extractStrokeSegments(tail(5), require('../htdocs/signature_recognition.js').DEFAULTS);
    check('短斜尾 (~12.5px) 被吸收 (1 段 R)', rShort.sequence === 'R' && rShort.count === 1,
        `${rShort.sequence} (${rShort.count} 段)`);
    const rLong = extractStrokeSegments(tail(27), require('../htdocs/signature_recognition.js').DEFAULTS);
    check('长斜尾 (~67px) 如实识别为 R,RU', rLong.sequence === 'RRU' && rLong.count === 2,
        `${rLong.sequence} (${rLong.count} 段)`);
}
// 有意 "へ": 两腿各 70px 的开阔 V 形, 应保留为两段对角
{
    const pts = [];
    let x = 0, y = 0;
    pts.push({ x, y });
    for (let i = 0; i < 50; i++) { x += 1; y -= 1; pts.push({ x, y }); }  // RU 70.7
    for (let i = 0; i < 50; i++) { x += 1; y += 1; pts.push({ x, y }); }  // RD 70.7
    const r = extractStrokeSegments(pts, require('../htdocs/signature_recognition.js').DEFAULTS);
    check('有意 "へ" 长腿转折被保留 (RURD)', r.sequence === 'RURD' && r.count === 2, `${r.sequence} (${r.count} 段)`);
}
// 中等长度转折 (腿 40px): 在 2× 门槛边缘, 应保留 (40 ≥ max(20, 4%×总长))
{
    const pts = [];
    let x = 0, y = 0;
    pts.push({ x, y });
    for (let i = 0; i < 28; i++) { x += 1; y -= 1; pts.push({ x, y }); } // RU 39.6
    for (let i = 0; i < 28; i++) { x += 1; y += 1; pts.push({ x, y }); } // RD 39.6
    const r = extractStrokeSegments(pts, require('../htdocs/signature_recognition.js').DEFAULTS);
    check('40px 腿长的转折仍保留', r.sequence === 'RURD' && r.count === 2, `${r.sequence} (${r.count} 段)`);
}
// 多笔画中某笔含 45° 斜线 → 现在被接受为对角线段 (不再拒绝)
{
    const s1 = render([
        { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 },
        { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 },
        { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 },
    ], { jitter: 0.5 });
    const pts2 = [];
    let x = 0, y = 0;
    pts2.push({ x, y });
    for (let i = 0; i < 40; i++) { x += 2; y -= 2; pts2.push({ x, y }); } // 45° 右上
    const r = recognizeStrokes([s1, pts2]);
    check('含 45° 斜线的笔画被接受为对角线段 (13 段)',
        r.valid && r.sequence === 'RURURURURURURU' && r.count === 13, `${r.message} seq=${r.sequence}`);
}

// 山川: 整体走势随机 15°~24° (↘), 每个波峰左右腿相对走势 ±(61°~64°), 腿长 40~50px, 5 个波峰。
// 该取值范围内: 左腿 −37°~−49° 恒为 RU, 右腿 76°~88° 恒为 D, 期望序列不变。
// ⚠️ 注意: 腿角距扇区边界 ±5° 以内是固有量化边界 (任何识别器都会随抖动翻转),
//     测试范围刻意避开; 用户画图案也应避开边界角。
// 旧实现 (无拐角精化) 在此用例上 298/300, 失败腿被吞。
function renderMountain(opts = {}) {
    const { jitter = 1.0, scale = 1, ox = 0, oy = 0, driftDeg = 15, legDeg = 60, legLen = 42 } = opts;
    const drift = driftDeg * Math.PI / 180;
    const legAng = legDeg * Math.PI / 180;
    const L = legLen * scale;
    const pts = [];
    let x = ox, y = oy;
    const push = (px, py) => pts.push({ x: px + gauss() * jitter, y: py + gauss() * jitter });
    push(x, y);
    for (let i = 0; i < 10; i++) { // 10 条腿 = 5 个波峰
        const a = drift + (i % 2 === 0 ? -legAng : legAng);
        const vx = Math.cos(a), vy = Math.sin(a);
        let rem = L;
        while (rem > 0) { const s = Math.min(2, rem); x += vx * s; y += vy * s; rem -= s; push(x, y); }
    }
    return pts;
}

console.log('== 山川走势 (随机↘漂移 + 5 个 ∧ 波峰, 300 次须 100%) ==');
{
    const SEQ = 'RUDRUDRUDRUDRUD';
    let ok = 0;
    const fails = [];
    for (let i = 0; i < 300; i++) {
        const pts = renderMountain({
            jitter: 0.5 + Math.random() * 1.0,
            scale: 0.85 + Math.random() * 0.3,
            ox: (Math.random() - 0.5) * 160,
            oy: (Math.random() - 0.5) * 60,
            driftDeg: 15 + Math.random() * 9,   // 15°~24°
            legDeg: 61 + Math.random() * 3,     // 61°~64°
            legLen: 40 + Math.random() * 10,    // 40~50px
        });
        const r = recognizeSequence(pts);
        if (r.valid && r.sequence === SEQ) ok++;
        else fails.push(`${r.sequence || r.message}`);
    }
    check(`山川 300 次一致率 ${ok}/300`, ok === 300, `失败 ${300 - ok} 次: ${fails.slice(0, 4).join(' | ')}`);
}

// 大圆弧: 半径 = 弧长/总转角, 从水平切线开始向下弯 (整体走势 = 起始切线 + θ/2)
function renderArc(opts = {}) {
    const { jitter = 1.0, scale = 1, ox = 0, oy = 0, turnDeg = 40, length = 300 } = opts;
    const theta = turnDeg * Math.PI / 180;
    const R = length / theta;
    const pts = [];
    const n = Math.max(2, Math.floor(length / 2));
    const push = (px, py) => pts.push({ x: px + gauss() * jitter, y: py + gauss() * jitter });
    for (let i = 0; i <= n; i++) {
        const phi = theta * i / n;
        push(ox + R * Math.sin(phi) * scale, oy + R * (1 - Math.cos(phi)) * scale);
    }
    return pts;
}

console.log('== 大圆弧 (挺直的弧线, 应合并为单段走势, 各 100 次须 100%) ==');
// 用 extractStrokeSegments 断言 (单条弧只有 1 段, recognizeSequence 的 10 段门槛不适用)
{
    // 40° 弧: DP 会在弧中点劈出顶点, 但局部转向角 ~2°, 低于 minCornerTurn → 顶点删除
    // → 单段, 净方向 = 20° → R
    let ok = 0;
    const fails = [];
    for (let i = 0; i < 100; i++) {
        const pts = renderArc({
            jitter: 0.5 + Math.random() * 1.0,
            turnDeg: 40, length: 300,
            scale: 0.85 + Math.random() * 0.3,
            ox: (Math.random() - 0.5) * 100, oy: (Math.random() - 0.5) * 50,
        });
        const r = extractStrokeSegments(pts, DEFAULTS);
        if (r.sequence === 'R' && r.count === 1) ok++;
        else fails.push(`${r.sequence}(${r.count})`);
    }
    check(`40° 大圆弧 → 单段 R (${ok}/100)`, ok === 100, fails.slice(0, 3).join(' | '));
    // 80° 弧: 净方向 = 40° (右下) → RD
    ok = 0;
    fails.length = 0;
    for (let i = 0; i < 100; i++) {
        const pts = renderArc({
            jitter: 0.5 + Math.random() * 1.0,
            turnDeg: 80, length: 300,
            scale: 0.85 + Math.random() * 0.3,
            ox: (Math.random() - 0.5) * 100, oy: (Math.random() - 0.5) * 50,
        });
        const r = extractStrokeSegments(pts, DEFAULTS);
        if (r.sequence === 'RD' && r.count === 1) ok++;
        else fails.push(`${r.sequence}(${r.count})`);
    }
    check(`80° 大圆弧 → 单段 RD (${ok}/100)`, ok === 100, fails.slice(0, 3).join(' | '));
}

console.log('== 八方向分类 ==');

// 纯几何分类 (无噪声): 8 个扇区的边界行为
{
    const line = (angleDeg, len = 120) => {
        const rad = angleDeg * Math.PI / 180;
        const pts = [];
        const n = Math.max(2, Math.floor(len / 2));
        for (let i = 0; i <= n; i++) {
            pts.push({ x: Math.cos(rad) * (len * i / n), y: -Math.sin(rad) * (len * i / n) });
        }
        return pts;
    };
    const cases = [
        [0, 'R'], [20, 'R'], [24, 'R'], [30, 'RU'], [45, 'RU'], [60, 'RU'], [65, 'U'],
        [90, 'U'], [110, 'U'], [120, 'LU'], [135, 'LU'], [150, 'LU'], [155, 'L'], [180, 'L'],
        [200, 'L'], [210, 'LD'], [225, 'LD'], [240, 'LD'], [245, 'D'], [270, 'D'],
        [295, 'D'], [300, 'RD'], [315, 'RD'], [340, 'R'],
    ];
    let allOk = true;
    const details = [];
    for (const [deg, expect] of cases) {
        const r = extractStrokeSegments(line(deg), Object.assign({}, require('../htdocs/signature_recognition.js').DEFAULTS));
        const got = r.sequence;
        if (got !== expect) { allOk = false; details.push(`${deg}°→${got}(期望${expect})`); }
    }
    check('八方向扇区分类 (18 个角度)', allOk, details.join(' '));
}
// 对角线在图案中的编码: RU/RD/LD/LU 双字母, 与主轴不混淆
{
    const pts = [];
    let x = 0, y = 0;
    pts.push({ x, y });
    for (let i = 0; i < 60; i++) { x += 2; y -= 2; pts.push({ x, y }); } // 45° 右上 → RU
    const r = extractStrokeSegments(pts, require('../htdocs/signature_recognition.js').DEFAULTS);
    check('45° 右上 → RU', r.sequence === 'RU', r.sequence);
}
// 八方向图案随机抖动往返 200 次
{
    const DIRS8 = ['R', 'RU', 'U', 'LU', 'L', 'LD', 'D', 'RD'];
    const ANGLE = { R: 0, RU: 45, U: 90, LU: 135, L: 180, LD: 225, D: 270, RD: 315 };
    const segs = [];
    for (let i = 0; i < 12; i++) {
        const d = DIRS8[i % 8];
        segs.push({ dir: d, length: 40 });
    }
    const SEQ = segs.map(s => s.dir).join('');
    let ok = 0;
    const fails = [];
    for (let i = 0; i < 200; i++) {
        const pts = render(segs, { jitter: 1.0, scale: 0.9 + Math.random() * 0.3 });
        const r = recognizeSequence(pts);
        if (r.valid && r.sequence === SEQ) ok++;
        else fails.push(r.message);
    }
    check(`八方向图案抖动往返一致率 ${ok}/200`, ok >= 198, `失败: ${fails.slice(0, 3).join(' | ')}`);
}

console.log('== 错误路径 ==');
// 极浅倾斜 (15°) 仍归为主轴
{
    const pts = [];
    let x = 0, y = 0;
    pts.push({ x, y });
    for (let i = 0; i < 120; i++) { x += 2; y -= 0.536; pts.push({ x, y }); } // ~15°
    const r = extractStrokeSegments(pts, require('../htdocs/signature_recognition.js').DEFAULTS);
    check('~15° 倾斜归为 R (不产生对角线)', r.sequence === 'R', r.sequence);
}
// 短段被丢弃: 中间 4px 的段不应出现在序列里 (且两侧同向段合并)
// 用固定随机种子保证确定性 (该场景的噪声结构敏感)
{
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    const savedRandom = Math.random;
    Math.random = mulberry32(42);
    const segs = [
        { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 4 },
        { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'D', length: 40 },
        { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 },
        { dir: 'D', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 },
    ];
    const pts = render(segs, { jitter: 1.0, cornerRadius: 3 });
    const r = recognizeSequence(pts);
    Math.random = savedRandom;
    const expected = 'RURDRURDRU'; // 去掉 4px 的 R, 两侧 U 合并: 10 段
    check('短段(<阈值)被丢弃且同向段合并', r.valid && r.sequence === expected,
        `${r.valid} seq=${r.sequence} expect=${expected} msg=${r.message}`);
}
// 段数不足
{
    const pts = render([{ dir: 'R', length: 60 }, { dir: 'U', length: 40 }], { jitter: 1.0 });
    const r = recognizeSequence(pts);
    check('2 段图案被拒 (too_few_segments)', r.valid === false && r.invalidReason === 'too_few_segments', r.message);
}
// 空输入
{
    const r = recognizeSequence([]);
    check('空输入被拒', r.valid === false && r.invalidReason === 'empty');
    const r2 = recognizeSequence(null);
    check('null 输入被拒', r2.valid === false);
}
// 真实抖动模型 (均值回归): 笔迹保持方向, 只有位置噪声, 不随机游走漂移
{
    const pts = [];
    let x = 0, y = 0;
    pts.push({ x, y });
    for (let i = 0; i < 120; i++) { x += 2; pts.push({ x, y: y + gauss() * 1.5 }); }
    const r = recognizeSequence(pts);
    check('抖动水平线未被误判为斜线', r.invalidReason !== 'diagonal', r.message);
    check('抖动水平线未产生噪声段', !r.valid || r.count <= 1, r.message);
}

console.log('== v2 新增: 增量识别器 / 手速不均 / 浅转角 / 性能 ==');

// 增量识别器与全量识别等价: 每加一笔前的"预览"与 recognizeStrokes 一致
{
    const s1 = render(INTENT, { jitter: 0.5 });
    const s2 = render([
        { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 },
        { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 },
    ], { jitter: 0.5, ox: 300, oy: 40 });
    const rec = createIncrementalRecognizer();
    const r0 = rec.result(s2); // 未落笔时 s2 是"预览"
    const r1 = recognizeStrokes([s1, s2]);
    rec.addStroke(s1);
    const r2 = rec.result(s2); // s1 已缓存, 只重算 s2
    const full = recognizeStrokes([s1, s2]);
    check('增量识别: 预览/落笔与全量识别一致',
        r2.valid && r2.sequence === full.sequence && r0.sequence !== r2.sequence,
        `${r0.sequence} vs ${r2.sequence} vs ${full.sequence}`);
    rec.addStroke(s2);
    const r3 = rec.result();
    check('增量识别: 落笔后结果一致', r3.valid && r3.sequence === full.sequence, r3.message);
    rec.removeLast();
    const r4 = rec.result();
    check('增量识别: 撤回与全量一致', r4.valid && r4.sequence === recognizeStrokes([s1]).sequence,
        `${r4.sequence} vs ${recognizeStrokes([s1]).sequence}`);
    rec.clear();
    check('增量识别: 清空后退回 empty', rec.result().invalidReason === 'empty', rec.result().message);
}

// 性能: 长笔画 (含不均匀手速: 稀疏采样), 单次提取必须 < 10ms (实测 ~1ms)
{
    const big = [];
    let x = 0, y = 0;
    const leg = (dx, dy, len) => {
        const n = Math.round(len / 2);
        for (let i = 0; i < n; i++) {
            x += dx * 2; y += dy * 2;
            big.push({ x: x + gauss() * 0.8, y: y + gauss() * 0.8 });
        }
    };
    for (let k = 0; k < 4; k++) {
        leg(1, 0, 90); leg(0, -1, 70); leg(1, 0, 80); leg(0, 1, 70);
        leg(-1, 0, 85); leg(0, -1, 72); leg(1, 0, 84); leg(0, 1, 70);
        leg(1, 0, 78); leg(0, -1, 66); leg(-1, 0, 74); leg(0, 1, 68);
    }
    const sparse = [];
    for (let i = 0; i < big.length; i += 3) sparse.push(big[i]); // 模拟快速移动的稀疏采样
    const t0 = process.hrtime.bigint();
    const n = 20;
    let seq = '';
    for (let i = 0; i < n; i++) seq = extractStrokeSegments(sparse, DEFAULTS).sequence;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
    const expect = 'RURDLURDRULD'.repeat(4);
    check(`稀疏采样长笔画识别 (${sparse.length} 点, 平均 ${ms.toFixed(2)}ms/次, 须 <10ms)`,
        seq === expect && ms < 10, `${seq.slice(0, 48)} vs ${expect.slice(0, 48)} (${ms.toFixed(2)}ms)`);
}

// 浅转角回归: 37° 转向 + 抖动 (v1 的 minCornerTurn=45° 会把整条尾巴误并入主线)
{
    let ok = 0;
    for (let i = 0; i < 100; i++) {
        const pts = [];
        let x = 0, y = 0;
        pts.push({ x, y });
        for (let k = 0; k < 90; k++) { x += 2; pts.push({ x, y: y + gauss() * 0.8 }); }
        for (let k = 0; k < 27; k++) { x += 2; y -= 1.5; pts.push({ x: x + gauss() * 0.8, y: y + gauss() * 0.8 }); }
        const r = extractStrokeSegments(pts, DEFAULTS);
        if (r.sequence === 'RRU' && r.count === 2) ok++;
    }
    check(`37° 浅转角 + 抖动 100 次全部保留为 R,RU (${ok}/100)`, ok === 100, `${ok}/100`);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
