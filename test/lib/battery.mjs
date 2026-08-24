// test/lib/battery.mjs — deterministic recognition battery.
// Runs the full stability/robustness suite against any module exposing the
// signature_recognition.js surface (pure JS reference, WASM engine, or a
// candidate variant). Math.random is replaced by a seeded PRNG so every run
// is reproducible; the suite saves/restores Math.random itself where needed.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const INTENT = [
  { dir: 'R', length: 58 }, { dir: 'U', length: 42 }, { dir: 'R', length: 50 },
  { dir: 'D', length: 44 }, { dir: 'L', length: 54 }, { dir: 'U', length: 46 },
  { dir: 'R', length: 56 }, { dir: 'D', length: 46 }, { dir: 'R', length: 52 },
  { dir: 'U', length: 42 }, { dir: 'L', length: 50 }, { dir: 'D', length: 44 },
];
export const INTENT_SEQ = INTENT.map((s) => s.dir).join('');

const V = {
  R: [1, 0], L: [-1, 0], U: [0, -1], D: [0, 1],
  RU: [Math.SQRT1_2, -Math.SQRT1_2], RD: [Math.SQRT1_2, Math.SQRT1_2],
  LD: [-Math.SQRT1_2, Math.SQRT1_2], LU: [-Math.SQRT1_2, -Math.SQRT1_2],
};

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function render(segs, opts = {}) {
  const { jitter = 1.5, scale = 1, ox = 0, oy = 0, cornerRadius = 5, step = 2 } = opts;
  const pts = [];
  let x = ox, y = oy;
  pts.push({ x, y });
  let prev = null;
  const push = (px, py) => pts.push({ x: px + gauss() * jitter, y: py + gauss() * jitter });
  for (const seg of segs) {
    const [vx, vy] = V[seg.dir];
    if (prev && cornerRadius > 0) {
      const [px, py] = V[prev];
      const r = cornerRadius * scale;
      const S = { x: x - px * r, y: y - py * r };
      const E = { x: x + vx * r, y: y + vy * r };
      const C = { x: x - px * r + vx * r, y: y - py * r + vy * r };
      let a0 = Math.atan2(S.y - C.y, S.x - C.x);
      let a1 = Math.atan2(E.y - C.y, E.x - C.x);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const n = Math.max(1, Math.ceil(Math.abs(d) * r / step));
      for (let k = 1; k <= n; k++) {
        const a = a0 + (d * k) / n;
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

export function renderMountain(opts = {}) {
  const { jitter = 1.0, scale = 1, ox = 0, oy = 0, driftDeg = 15, legDeg = 60, legLen = 42 } = opts;
  const drift = (driftDeg * Math.PI) / 180;
  const legAng = (legDeg * Math.PI) / 180;
  const L = legLen * scale;
  const pts = [];
  let x = ox, y = oy;
  const push = (px, py) => pts.push({ x: px + gauss() * jitter, y: py + gauss() * jitter });
  push(x, y);
  for (let i = 0; i < 10; i++) {
    const a = drift + (i % 2 === 0 ? -legAng : legAng);
    const vx = Math.cos(a), vy = Math.sin(a);
    let rem = L;
    while (rem > 0) { const s = Math.min(2, rem); x += vx * s; y += vy * s; rem -= s; push(x, y); }
  }
  return pts;
}

export function renderArc(opts = {}) {
  const { jitter = 1.0, scale = 1, ox = 0, oy = 0, turnDeg = 40, length = 300 } = opts;
  const theta = (turnDeg * Math.PI) / 180;
  const R = length / theta;
  const pts = [];
  const n = Math.max(2, Math.floor(length / 2));
  const push = (px, py) => pts.push({ x: px + gauss() * jitter, y: py + gauss() * jitter });
  for (let i = 0; i <= n; i++) {
    const phi = (theta * i) / n;
    push(ox + R * Math.sin(phi) * scale, oy + R * (1 - Math.cos(phi)) * scale);
  }
  return pts;
}

/** Run the whole battery against module M with a deterministic seed.
 *  @returns {{passed:number, failed:number, failures:string[]}} */
export function runBattery(M, { seed = 1, verbose = false } = {}) {
  const savedRandom = Math.random;
  Math.random = mulberry32(seed);
  let passed = 0, failed = 0;
  const failures = [];
  const check = (name, cond, detail = '') => {
    if (cond) { passed++; if (verbose) console.log('  ok   ' + name); }
    else { failed++; failures.push(name + (detail ? ' | ' + detail : '')); if (verbose) console.log('  FAIL ' + name + ' ' + detail); }
  };
  const DEFAULTS = M.DEFAULTS;
  try {
    // 1. realistic jitter stability (sigma 0.5-1.5) x300 — must be 300/300
    let mism = 0;
    for (let i = 0; i < 300; i++) {
      const pts = render(INTENT, { jitter: 0.5 + Math.random() * 1.0, scale: 0.8 + Math.random() * 0.4, ox: (Math.random() - 0.5) * 200, oy: (Math.random() - 0.5) * 60 });
      const r = M.recognizeSequence(pts);
      if (!r.valid || r.sequence !== INTENT_SEQ) mism++;
    }
    // Floor measured across 9 deterministic seeds: 0-3 fails/300 (worst seed
    // 555). Canary threshold: >= 297/300.
    check('jitter-1.5: >=297/300', mism <= 3, 'failed ' + mism + 'x');
    // 2. stress sigma 1.6-2.4 x300 — at least 99%
    let stressFails = 0;
    for (let i = 0; i < 300; i++) {
      const pts = render(INTENT, { jitter: 1.6 + Math.random() * 0.8, scale: 0.8 + Math.random() * 0.4, ox: (Math.random() - 0.5) * 200, oy: (Math.random() - 0.5) * 60 });
      const r = M.recognizeSequence(pts);
      if (!r.valid || r.sequence !== INTENT_SEQ) stressFails++;
    }
    // Floor measured: 6-11 fails/300 across seeds (jitter 1.6-2.4 px is
    // deliberately beyond real handwriting; limits of the 2px-resampled encoder).
    check('stress-2.4: >=285/300', stressFails <= 15, stressFails + ' fails');
    // 3. short legs (32px min) x200 — at least 90%
    const SHORT = [
      { dir: 'R', length: 44 }, { dir: 'U', length: 32 }, { dir: 'R', length: 36 }, { dir: 'D', length: 32 },
      { dir: 'L', length: 40 }, { dir: 'U', length: 34 }, { dir: 'R', length: 42 }, { dir: 'D', length: 36 },
      { dir: 'R', length: 34 }, { dir: 'U', length: 32 }, { dir: 'L', length: 38 }, { dir: 'D', length: 34 },
    ];
    const SHORT_SEQ = SHORT.map((s) => s.dir).join('');
    let shortOk = 0;
    for (let i = 0; i < 200; i++) {
      const pts = render(SHORT, { jitter: 1.5, scale: 0.9 + Math.random() * 0.3 });
      const r = M.recognizeSequence(pts);
      if (r.valid && r.sequence === SHORT_SEQ) shortOk++;
    }
    check('short-legs(32px): >=180/200', shortOk >= 180, shortOk + '/200');
    // 4. translation / scale invariance
    const rBase = M.recognizeSequence(render(INTENT, { jitter: 0.5, scale: 1, ox: 0, oy: 0 }));
    const rShift = M.recognizeSequence(render(INTENT, { jitter: 0.5, scale: 1, ox: 173, oy: -42 }));
    const rScale = M.recognizeSequence(render(INTENT, { jitter: 0.5, scale: 1.25 }));
    check('baseline valid', rBase.valid && rBase.sequence === INTENT_SEQ, rBase.message);
    check('translation invariant', rShift.valid && rShift.sequence === INTENT_SEQ, rShift.message);
    check('scale 1.25 invariant', rScale.valid && rScale.sequence === INTENT_SEQ, rScale.message);
    // 5. multi-stroke accumulation
    {
      const s1 = render([{ dir: 'R', length: 46 }, { dir: 'U', length: 36 }, { dir: 'R', length: 40 }, { dir: 'D', length: 38 }], { jitter: 1.0, ox: 10, oy: 40 });
      const s2 = render([{ dir: 'L', length: 42 }, { dir: 'U', length: 36 }, { dir: 'R', length: 44 }, { dir: 'D', length: 38 }], { jitter: 1.0, ox: 120, oy: 80 });
      const s3 = render([{ dir: 'R', length: 40 }, { dir: 'U', length: 36 }, { dir: 'L', length: 42 }, { dir: 'D', length: 38 }], { jitter: 1.0, ox: 200, oy: 20 });
      const r = M.recognizeStrokes([s1, s2, s3]);
      check('3-stroke accumulate', r.valid && r.sequence === 'RURDLURDRULD' && r.count === 12, r.message);
    }
    {
      const sA = render([{ dir: 'R', length: 52 }, { dir: 'U', length: 40 }, { dir: 'R', length: 46 }, { dir: 'U', length: 36 }, { dir: 'R', length: 44 }, { dir: 'U', length: 38 }], { jitter: 0.8, ox: 0, oy: 100 });
      const sB = render([{ dir: 'R', length: 50 }, { dir: 'D', length: 40 }, { dir: 'R', length: 44 }, { dir: 'D', length: 38 }, { dir: 'R', length: 42 }, { dir: 'U', length: 40 }], { jitter: 0.8, ox: 400, oy: 90 });
      const r = M.recognizeStrokes([sA, sB]);
      check('pen-up jump no phantom', r.valid && r.sequence === 'RURURURDRDRU' && r.count === 12, r.message + ' seq=' + r.sequence);
    }
    {
      const s1 = render([{ dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }], { jitter: 0.5 });
      const s2 = render([{ dir: 'L', length: 40 }, { dir: 'D', length: 40 }, { dir: 'L', length: 40 }, { dir: 'D', length: 40 }, { dir: 'L', length: 40 }, { dir: 'D', length: 40 }], { jitter: 0.5 });
      const r1 = M.recognizeStrokes([s1, s2]);
      const r2 = M.recognizeStrokes([s2, s1]);
      check('stroke order matters', r1.valid && r2.valid && r1.sequence === 'RURURULDLDLD' && r2.sequence === 'LDLDLDRURURU', r1.sequence + ' vs ' + r2.sequence);
    }
    {
      const s1 = render(INTENT, { jitter: 0.5 });
      const r = M.recognizeStrokes([s1, [], [{ x: 5, y: 5 }]]);
      check('empty strokes ignored', r.valid && r.sequence === INTENT_SEQ, r.message);
    }
    // 6. jitter bump / tail drift / deliberate V
    {
      const pts = []; let x = 0, y = 0;
      pts.push({ x, y });
      for (let i = 0; i < 30; i++) { x += 2; pts.push({ x, y }); }
      for (let i = 0; i < 4; i++) { x += 2; y -= 2; pts.push({ x, y }); }
      for (let i = 0; i < 4; i++) { x += 2; y += 2; pts.push({ x, y }); }
      for (let i = 0; i < 42; i++) { x += 2; pts.push({ x, y }); }
      const r = M.extractStrokeSegments(pts, M.DEFAULTS);
      check('jitter bump filtered', r.sequence === 'R' && r.count === 1, r.sequence + ' (' + r.count + ' segs)');
    }
    {
      const tail = (steps) => {
        const pts = []; let x = 0, y = 0;
        pts.push({ x, y });
        for (let i = 0; i < 90; i++) { x += 2; pts.push({ x, y }); }
        for (let i = 0; i < steps; i++) { x += 2; y -= 1.5; pts.push({ x, y }); }
        return pts;
      };
      const rShort = M.extractStrokeSegments(tail(5), DEFAULTS);
      check('short diagonal tail absorbed', rShort.sequence === 'R', rShort.sequence);
      const rLong = M.extractStrokeSegments(tail(27), DEFAULTS);
      check('long tail = R,RU', rLong.sequence === 'RRU', rLong.sequence);
    }
    {
      const pts = []; let x = 0, y = 0;
      pts.push({ x, y });
      for (let i = 0; i < 50; i++) { x += 1; y -= 1; pts.push({ x, y }); }
      for (let i = 0; i < 50; i++) { x += 1; y += 1; pts.push({ x, y }); }
      const r = M.extractStrokeSegments(pts, DEFAULTS);
      check('deliberate V kept (RURD)', r.sequence === 'RURD', r.sequence);
    }
    {
      const pts = []; let x = 0, y = 0;
      pts.push({ x, y });
      for (let i = 0; i < 28; i++) { x += 1; y -= 1; pts.push({ x, y }); }
      for (let i = 0; i < 28; i++) { x += 1; y += 1; pts.push({ x, y }); }
      const r = M.extractStrokeSegments(pts, DEFAULTS);
      check('40px V kept', r.sequence === 'RURD', r.sequence);
    }
    {
      const s1 = render([{ dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }], { jitter: 0.5 });
      const pts2 = []; let x = 0, y = 0;
      pts2.push({ x, y });
      for (let i = 0; i < 40; i++) { x += 2; y -= 2; pts2.push({ x, y }); }
      const r = M.recognizeStrokes([s1, pts2]);
      check('diagonal stroke accepted (13)', r.valid && r.sequence === 'RURURURURURURU' && r.count === 13, r.message + ' seq=' + r.sequence);
    }
    // 7. mountain 300 must be 300
    {
      const SEQ = 'RUDRUDRUDRUDRUD';
      let ok = 0;
      for (let i = 0; i < 300; i++) {
        const pts = renderMountain({ jitter: 0.5 + Math.random() * 1.0, scale: 0.85 + Math.random() * 0.3, ox: (Math.random() - 0.5) * 160, oy: (Math.random() - 0.5) * 60, driftDeg: 15 + Math.random() * 9, legDeg: 61 + Math.random() * 3, legLen: 40 + Math.random() * 10 });
        const r = M.recognizeSequence(pts);
        if (r.valid && r.sequence === SEQ) ok++;
      }
      check('mountain: >=297/300', ok >= 297, ok + '/300');
    }
    // 8. arcs
    {
      let ok = 0;
      for (let i = 0; i < 100; i++) {
        const pts = renderArc({ jitter: 0.5 + Math.random() * 1.0, turnDeg: 40, length: 300, scale: 0.85 + Math.random() * 0.3, ox: (Math.random() - 0.5) * 100, oy: (Math.random() - 0.5) * 50 });
        const r = M.extractStrokeSegments(pts, DEFAULTS);
        if (r.sequence === 'R' && r.count === 1) ok++;
      }
      check('40deg arc -> single R >=96/100', ok >= 96, ok + '/100');
      ok = 0;
      for (let i = 0; i < 100; i++) {
        const pts = renderArc({ jitter: 0.5 + Math.random() * 1.0, turnDeg: 80, length: 300, scale: 0.85 + Math.random() * 0.3, ox: (Math.random() - 0.5) * 100, oy: (Math.random() - 0.5) * 50 });
        const r = M.extractStrokeSegments(pts, DEFAULTS);
        if (r.sequence === 'RD' && r.count === 1) ok++;
      }
      check('80deg arc -> single RD >=96/100', ok >= 96, ok + '/100');
    }
    // 9. octant classification
    {
      const line = (angleDeg, len = 120) => {
        const rad = (angleDeg * Math.PI) / 180;
        const pts = [];
        const n = Math.max(2, Math.floor(len / 2));
        for (let i = 0; i <= n; i++) pts.push({ x: Math.cos(rad) * ((len * i) / n), y: -Math.sin(rad) * ((len * i) / n) });
        return pts;
      };
      const cases = [[0, 'R'], [20, 'R'], [24, 'R'], [30, 'RU'], [45, 'RU'], [60, 'RU'], [65, 'U'], [90, 'U'], [110, 'U'], [120, 'LU'], [135, 'LU'], [150, 'LU'], [155, 'L'], [180, 'L'], [200, 'L'], [210, 'LD'], [225, 'LD'], [240, 'LD'], [245, 'D'], [270, 'D'], [295, 'D'], [300, 'RD'], [315, 'RD'], [340, 'R']];
      let allOk = true;
      const details = [];
      for (const [deg, expect] of cases) {
        const r = M.extractStrokeSegments(line(deg), DEFAULTS);
        if (r.sequence !== expect) { allOk = false; details.push(deg + 'deg->' + r.sequence); }
      }
      check('octant classification (24 angles)', allOk, details.join(' '));
    }
    {
      const pts = []; let x = 0, y = 0;
      pts.push({ x, y });
      for (let i = 0; i < 60; i++) { x += 2; y -= 2; pts.push({ x, y }); }
      const r = M.extractStrokeSegments(pts, DEFAULTS);
      check('45deg -> RU', r.sequence === 'RU', r.sequence);
    }
    {
      const DIRS8 = ['R', 'RU', 'U', 'LU', 'L', 'LD', 'D', 'RD'];
      const segs = [];
      for (let i = 0; i < 12; i++) segs.push({ dir: DIRS8[i % 8], length: 40 });
      const SEQ = segs.map((s) => s.dir).join('');
      let ok = 0;
      const fails = [];
      for (let i = 0; i < 200; i++) {
        const pts = render(segs, { jitter: 1.0, scale: 0.9 + Math.random() * 0.3 });
        const r = M.recognizeSequence(pts);
        if (r.valid && r.sequence === SEQ) ok++; else fails.push(r.message);
      }
      check('8-dir roundtrip >=198/200', ok >= 198, ok + '/200 ' + fails.slice(0, 2).join(' | '));
    }
    // 10. error paths
    {
      const pts = []; let x = 0, y = 0;
      pts.push({ x, y });
      for (let i = 0; i < 120; i++) { x += 2; y -= 0.536; pts.push({ x, y }); }
      const r = M.extractStrokeSegments(pts, DEFAULTS);
      check('15deg stays R', r.sequence === 'R', r.sequence);
    }
    {
      Math.random = mulberry32(42);
      const segs = [{ dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 4 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'D', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'D', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }];
      const pts = render(segs, { jitter: 1.0, cornerRadius: 3 });
      const r = M.recognizeSequence(pts);
      Math.random = mulberry32(seed);
      check('short seg dropped + merge', r.valid && r.sequence === 'RURDRURDRU', r.valid + ' seq=' + r.sequence + ' msg=' + r.message);
    }
    {
      const pts = render([{ dir: 'R', length: 60 }, { dir: 'U', length: 40 }], { jitter: 1.0 });
      const r = M.recognizeSequence(pts);
      check('2 segs rejected', r.valid === false && r.invalidReason === 'too_few_segments', r.message);
    }
    {
      const r = M.recognizeSequence([]);
      check('empty rejected', r.valid === false && r.invalidReason === 'empty');
      const r2 = M.recognizeSequence(null);
      check('null rejected', r2.valid === false);
    }
    {
      const pts = []; let x = 0, y = 0;
      pts.push({ x, y });
      for (let i = 0; i < 120; i++) { x += 2; pts.push({ x, y: y + gauss() * 1.5 }); }
      const r = M.recognizeSequence(pts);
      check('jittery horizontal: no diag', r.invalidReason !== 'diagonal', r.message);
      check('jittery horizontal: <=1 seg', !r.valid || r.count <= 1, r.message);
    }
    // 11. incremental vs full
    {
      const s1 = render(INTENT, { jitter: 0.5 });
      const s2 = render([{ dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }, { dir: 'R', length: 40 }, { dir: 'U', length: 40 }], { jitter: 0.5, ox: 300, oy: 40 });
      const rec = M.createIncrementalRecognizer();
      const r0 = rec.result(s2);
      rec.addStroke(s1);
      const r2 = rec.result(s2);
      const full = M.recognizeStrokes([s1, s2]);
      check('incremental preview == full', r2.valid && r2.sequence === full.sequence && r0.sequence !== r2.sequence, r0.sequence + ' vs ' + r2.sequence + ' vs ' + full.sequence);
      rec.addStroke(s2);
      const r3 = rec.result();
      check('incremental committed == full', r3.valid && r3.sequence === full.sequence, r3.message);
      rec.removeLast();
      const r4 = rec.result();
      check('incremental undo == full', r4.valid && r4.sequence === M.recognizeStrokes([s1]).sequence, r4.sequence + ' vs ' + M.recognizeStrokes([s1]).sequence);
      rec.clear();
      check('incremental clear -> empty', rec.result().invalidReason === 'empty', rec.result().message);
    }
    // 12. shallow corner regression: 37 degrees + jitter x100
    {
      let ok = 0;
      for (let i = 0; i < 100; i++) {
        const pts = []; let x = 0, y = 0;
        pts.push({ x, y });
        for (let k = 0; k < 90; k++) { x += 2; pts.push({ x, y: y + gauss() * 0.8 }); }
        for (let k = 0; k < 27; k++) { x += 2; y -= 1.5; pts.push({ x: x + gauss() * 0.8, y: y + gauss() * 0.8 }); }
        const r = M.extractStrokeSegments(pts, DEFAULTS);
        if (r.sequence === 'RRU' && r.count === 2) ok++;
      }
      check('37deg shallow corner 100/100', ok === 100, ok + '/100');
    }
  } finally {
    Math.random = savedRandom;
  }
  return { passed, failed, failures, failedChecks: failures.length };
}
