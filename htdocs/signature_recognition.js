// signature_recognition.js -- hand-drawn pattern recognizer (8-direction chain code).
//
// This module is the pure-JS *reference implementation* and behavioral spec of the
// recognition pipeline. The WASM acceleration engine (recognition_engine.js) runs
// the exact same algorithm in Rust and falls back to this module when WebAssembly
// is unavailable. Tests enforce that both paths produce identical output.
//
// Pipeline (corner-profile driven):
//   1. Adaptive Douglas-Peucker simplification (de-noises jitter/back-loop rings).
//   2. Uniform arc-length resampling (hand-speed invariant).
//   3. Turn-angle profile over fixed-arc chords; local maxima = corners.
//   4. Segment building: direction = least-squares principal direction of each
//      segment's points (robust to corner-position error); arc length = path arc.
//   5. Iterative pruning: bridge (jitter V between same-direction neighbors),
//      between (rounded-corner arc tail), collinear (pseudo-peak), short legs.
//
// Output direction alphabet: main axes are single letters (R/L/U/D), diagonals
// are two letters (RU/RD/LD/LU). The chain code is translation/scale invariant:
// only the sequence of turns must match across repeated drawings.

export const DIR_ARROW = {
  R: "\u2192", L: "\u2190", U: "\u2191", D: "\u2193",
  RU: "\u2197", RD: "\u2198", LD: "\u2199", LU: "\u2196",
};

export const DIRS = ["R", "RU", "U", "LU", "L", "LD", "D", "RD"];

const OCTANT_RATIO = 0.5;

export const DEFAULTS = {
  simplifyTolerance: 8, // px: DP de-noising tolerance
  resampleStep: 2, // px: uniform arc-length resampling step
  cornerWindow: 10, // px: chord half-length of the turn-angle window (each side)
  cornerSmooth: 5, // profile smoothing window (in resampled points)
  minCornerTurn: 24, // deg: minimum local turn for a corner candidate
  cornerGap: 20, // px: merge corner candidates closer than this
  minLegLen: 18, // px: minimum path arc length of a kept segment
  minPointStep: 2, // px: ignore degenerate segments with chord below this
  fitTurnMin: 14, // deg: fitted-turn below this => vertices are collinear
  betweenMaxLen: 26, // px: absolute cap for "between" (arc-tail) segments
  betweenRatio: 0.65, // relative cap: betweenMaxLen vs 0.65 x shortest neighbor
  betweenStrong: 40, // deg: one flanking corner must turn at least this much
  minSegments: 10,
  maxSegments: 64,
};

// ================= 1. Basic geometry =================

/** Displacement (dx, dy) -> one of the 8 directions.
 *  Canvas coordinates: y grows downward, so dy > 0 means D (down). */
export function classifyDir(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const ratio = Math.min(ax, ay) / Math.max(ax, ay);
  if (ratio <= OCTANT_RATIO) {
    return ax >= ay ? (dx >= 0 ? "R" : "L") : dy >= 0 ? "D" : "U";
  }
  return (dx >= 0 ? "R" : "L") + (dy >= 0 ? "D" : "U");
}

/** Angle (0~180 deg) between vectors u and v; 0 for any zero vector. */
function vectorTurnDeg(ux, uy, vx, vy) {
  const cross = ux * vy - uy * vx;
  const dot = ux * vx + uy * vy;
  if (cross === 0 && dot === 0) return 0;
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

/** Distance from point p to the line through a-b. */
function pointLineDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const ex = p.x - (a.x + t * dx);
  const ey = p.y - (a.y + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

// ================= 2. Preprocessing =================

/** Iterative Douglas-Peucker simplification (no array slices; O(n log n)).
 *  Acts as a non-linear low-pass: folds jitter/back-loop rings, keeps real corners.
 *  @returns indices of kept points, strictly increasing, including first/last. */
export function simplifyPolylineIdx(points, epsilon) {
  const n = points.length;
  const keep = new Uint8Array(n);
  if (n <= 2) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointLineDist(points[i], points[a], points[b]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxI > 0 && maxD > epsilon) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Douglas-Peucker simplification returning points (compatibility helper). */
export function simplifyPolyline(points, epsilon) {
  return simplifyPolylineIdx(points, epsilon).map((i) => points[i]);
}

/** Uniform arc-length resampling (keeps first/last point). O(n). */
export function resamplePolyline(points, step) {
  const s = step > 0 ? step : 2;
  if (!points || points.length < 2) {
    return points ? points.map((p) => ({ x: p.x, y: p.y })) : [];
  }
  const out = [{ x: points[0].x, y: points[0].y }];
  let walked = 0; // arc length walked since the last output point
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x;
    const ay = points[i - 1].y;
    const bx = points[i].x;
    const by = points[i].y;
    const dx = bx - ax;
    const dy = by - ay;
    const segLen = Math.sqrt(dx*dx+ dy* dy);
    if (segLen === 0) continue;
    let t = 0;
    while (walked + (segLen - t) >= s) {
      t += s - walked;
      const r = t / segLen;
      out.push({ x: ax + dx * r, y: ay + dy * r });
      walked = 0;
    }
    walked += segLen - t;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (tail.x !== last.x || tail.y !== last.y) out.push({ x: last.x, y: last.y });
  return out;
}

/** Moving-average smoothing (O(n) prefix sums). Shrinking windows at the ends.
 *  Compatibility helper; the pipeline itself does not need it (DP output is
 *  already piecewise-linear). */
export function smoothPoints(points, window) {
  if (!points || points.length < 2) return points ? points.slice() : [];
  const w = Math.max(1, window | 0);
  const half = Math.floor(w / 2);
  const n = points.length;
  const px = new Float64Array(n + 1);
  const py = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    px[i + 1] = px[i] + points[i].x;
    py[i + 1] = py[i] + points[i].y;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const cnt = hi - lo + 1;
    out[i] = { x: (px[hi + 1] - px[lo]) / cnt, y: (py[hi + 1] - py[lo]) / cnt };
  }
  return out;
}

// ================= 3. Corner detection =================

/** k-th order statistic of a Float64Array (deterministic quickselect; O(n)
 *  average vs O(n log n) full sort; returns the same value as sorting, so it
 *  preserves exact parity with the Rust/WASM core and the old behaviour). */
function selectKth(arr, k) {
  let lo = 0;
  let hi = arr.length - 1;
  for (;;) {
    if (lo >= hi) return arr[lo];
    const pivot = arr[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) {
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return arr[k];
  }
}

/** Estimate jitter amplitude sigma-hat (px): 25th percentile of |second
 *  difference| / 2. Back-loop rings/corners/high-jitter regions pollute upper
 *  quantiles, but the 25th percentile always lies on "baseline straight"
 *  stretches; the ratio to true sigma is stable (~0.925).
 *  Used to adapt the DP tolerance. */
export function estimateJitterSigma(points) {
  const n = points.length;
  if (n < 8) return 0;
  const diffs = new Float64Array(n - 2);
  for (let i = 1; i < n - 1; i++) {
    const dx = points[i - 1].x - 2 * points[i].x + points[i + 1].x;
    const dy = points[i - 1].y - 2 * points[i].y + points[i + 1].y;
    diffs[i - 1] = Math.sqrt(dx * dx + dy * dy) / 2;
  }
  return selectKth(diffs, Math.floor(diffs.length * 0.25)) / 0.925;
}

/** Cumulative path arc lengths of a polyline (O(1) arc queries). */
function cumulativeArcLengths(pts) {
  const n = pts.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  return cum;
}

/** Corner detection: local maxima of the turn-angle profile.
 *  On DP-de-noised piecewise lines the local turn of each interior point is the
 *  angle between the two chords (cornerWindow px each side) crossing it. Real
 *  corners concentrate turn in a short arc -> profile peak; large arcs spread
 *  the turn over a long arc -> only a few degrees per window; jitter spikes are
 *  attenuated by the cornerSmooth window. The peak position is geometrically
 *  stable (does not jump with noise). Candidates below minCornerTurn are arcs/
 *  jitter and get ignored; candidates closer than cornerGap merge into the
 *  sharper one.
 *  @returns {{corners:number[], turn:Float64Array}} corners include first/last. */
function detectCorners(pts, o) {
  const n = pts.length;
  const K = Math.max(2, Math.round(o.cornerWindow / o.resampleStep));
  if (n < 2 * K + 1) return { corners: [0, n - 1], turn: new Float64Array(n) };
  const turn = new Float64Array(n);
  for (let i = K; i + K <= n - 1; i++) {
    turn[i] = vectorTurnDeg(
      pts[i].x - pts[i - K].x,
      pts[i].y - pts[i - K].y,
      pts[i + K].x - pts[i].x,
      pts[i + K].y - pts[i].y,
    );
  }
  // Profile smoothing: vertex jitter amplifies turn angles (midpoint error x2);
  // a 5-point window reduces it ~sqrt(5)x while real peaks (>=10 samples wide)
  // lose <10%.
  const H = Math.max(1, ((o.cornerSmooth | 0) - 1) >> 1); // +/-H points
  const t = new Float64Array(n);
  {
    const pref = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + turn[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - H) + 1;
      const hi = Math.min(n, i + H + 1);
      t[i] = (pref[hi] - pref[lo - 1]) / (hi - lo + 1);
    }
  }
  const minTurn = o.minCornerTurn;
  const minGap = Math.max(1, Math.round(o.cornerGap / o.resampleStep));
  const corners = [];
  for (let i = K; i + K <= n - 1; i++) {
    if (t[i] < minTurn) continue;
    // local maximum (plateau: take left end; peak offset <=1 sample ~2px)
    if (t[i] <= t[i - 1] || t[i] < t[i + 1]) continue;
    const last = corners[corners.length - 1];
    if (last !== undefined && i - last <= minGap) {
      if (t[i] > t[last]) corners[corners.length - 1] = i;
    } else {
      corners.push(i);
    }
  }
  return { corners: [0].concat(corners, [n - 1]), turn: t };
}

// ================= 4. Segmentation and pruning =================

/** Direction index on the 8-direction ring (for "between" tests). */
const DIR_INDEX = { R: 0, RU: 1, U: 2, LU: 3, L: 4, LD: 5, D: 6, RD: 7 };

/** Whether dir lies strictly between a and b on the short arc of the ring. */
function isBetweenMid(dir, a, b) {
  if (a === b) return false;
  const f = (x, y) => (DIR_INDEX[y] - DIR_INDEX[x] + 8) % 8;
  const arc = f(a, b);
  if (arc <= 4) return f(a, dir) > 0 && f(a, dir) < arc; // forward short arc
  const back = 8 - arc; // backward short arc
  return f(dir, a) > 0 && f(dir, a) < back;
}

/** Number of direction steps on the short arc between a and b (1..4). */
function shortArcSteps(a, b) {
  const f = (x, y) => (DIR_INDEX[y] - DIR_INDEX[x] + 8) % 8;
  return Math.min(f(a, b), 8 - f(a, b));
}

/** Least-squares principal direction of a point range: unit vector (dx, dy),
 *  oriented along the chord from pts[i0+margin] to pts[i1-margin].
 *  Returns null when too few points. */
function fitDirection(pts, i0, i1, margin) {
  const lo = i0 + margin;
  const hi = i1 - margin;
  const cnt = hi - lo + 1;
  if (cnt < 4) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = lo; i <= hi; i++) {
    const x = pts[i].x;
    const y = pts[i].y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const mx = sx / cnt;
  const my = sy / cnt;
  const vxx = sxx - cnt * mx * mx;
  const vyy = syy - cnt * my * my;
  const vxy = sxy - cnt * mx * my;
  const ang = 0.5 * Math.atan2(2 * vxy, vxx - vyy); // principal axis
  let dx = Math.cos(ang);
  let dy = Math.sin(ang);
  // Resolve orientation ambiguity: follow the chord head-to-tail
  const fx = pts[hi].x - pts[lo].x;
  const fy = pts[hi].y - pts[lo].y;
  if (dx * fx + dy * fy < 0) {
    dx = -dx;
    dy = -dy;
  }
  return { dx, dy };
}

/** Segment between adjacent corners: direction from the least-squares fit of
 *  the interior points (robust to corner-position error); arc from path arc
 *  length (independent of rounding); tin/tout = profile turns at the ends. */
function buildSegments(pts, cum, corners, turn, o) {
  const segs = [];
  for (let j = 1; j < corners.length; j++) {
    const i0 = corners[j - 1];
    const i1 = corners[j];
    if (i1 <= i0) continue;
    const dx = pts[i1].x - pts[i0].x;
    const dy = pts[i1].y - pts[i0].y;
    const chord = Math.sqrt(dx*dx+ dy* dy);
    if (chord < o.minPointStep) continue; // degenerate: skip
    const fit = fitDirection(pts, i0, i1, 1);
    segs.push({
      i0,
      i1,
      dx,
      dy,
      chord,
      arc: cum[i1] - cum[i0],
      dir: fit ? classifyDir(fit.dx, fit.dy) : classifyDir(dx, dy),
      tin: turn ? turn[i0] : 0,
      tout: turn ? turn[i1] : 0,
    });
  }
  return segs;
}

/** Merge adjacent same-direction segments (after a noise vertex is deleted the
 *  two sides return to the same direction). */
function mergeSameDir(list) {
  if (list.length < 2) return list;
  const out = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const s = list[i];
    const last = out[out.length - 1];
    if (last.dir === s.dir) {
      last.dx += s.dx;
      last.dy += s.dy;
      last.chord = Math.sqrt(last.dx*last.dx+ last.dy* last.dy);
      last.arc += s.arc;
      last.i1 = s.i1;
    } else {
      out.push(s);
    }
  }
  return out;
}

/** Delete the corner between two segments and stitch them (direction from net
 *  displacement). */
function stitch(a, b) {
  const dx = a.dx + b.dx;
  const dy = a.dy + b.dy;
  const chord = Math.sqrt(dx*dx+ dy* dy);
  // A zero (or sub-step) net displacement is a classification trap:
  // classifyDir(0,0) would yield an arbitrary diagonal. Fall back to the
  // direction of the longer half (the shorter one is the noise vertex).
  const dir = chord >= 2 ? classifyDir(dx, dy) : (a.chord >= b.chord ? a.dir : b.dir);
  return {
    i0: a.i0,
    i1: b.i1,
    dx,
    dy,
    chord,
    arc: a.arc + b.arc,
    dir,
    tin: a.tin,
    tout: b.tout,
  };
}

/** Iterative pruning: delete one "most likely noise" segment per round and
 *  re-merge until nothing is deletable. Candidate priority (evidence strong ->
 *  weak):
 *   1. bridge: short V between same-direction neighbors (jitter bump);
 *   2. between: direction strictly between neighbors + shorter than caps + a
 *      flank corner >= betweenStrong deg (rounded-corner arc tail);
 *   3. spike: short reversal OUTSIDE the neighbors' short fan (DP artifact at
 *      junctions: e.g. U -> D:23 -> R where the true corner is U -> R);
 *   4. collinear: fitted angle between neighboring chords < fitTurnMin (the
 *      vertex is a pseudo-peak; stitch both sides);
 *   5. short: arc length < minLegLen or chord < minPointStep.
 */
function pruneSegments(list, pts, o) {
  let cur = mergeSameDir(list);
  for (;;) {
    let bridge = -1;
    let between = -1;
    let spike = -1;
    let collinear = -1;
    let firstShort = -1;
    for (let i = 0; i < cur.length; i++) {
      const s = cur[i];
      const short = s.chord < o.minPointStep || s.arc < o.minLegLen;
      if (short && firstShort === -1) firstShort = i;
      const p = cur[i - 1];
      const n = cur[i + 1];
      if (p && n) {
        const lenCap = Math.max(o.betweenMaxLen, o.betweenRatio * Math.min(p.arc, n.arc));
        if (short && bridge === -1 && p.dir === n.dir) bridge = i;
        if (
          between === -1 &&
          isBetweenMid(s.dir, p.dir, n.dir) &&
          s.arc < lenCap &&
          Math.max(s.tin ? s.tin : 0, s.tout ? s.tout : 0) >= o.betweenStrong
        ) {
          between = i;
        }
        if (
          spike === -1 &&
          p.dir !== n.dir &&
          shortArcSteps(p.dir, n.dir) <= 3 && // neighbours' turn <= 135 deg (not a hairpin)
          !isBetweenMid(s.dir, p.dir, n.dir) &&
          s.arc < lenCap
        ) {
          spike = i;
        }
        if (
          collinear === -1 &&
          i > 0 &&
          s.chord >= o.minPointStep &&
          s.arc < o.betweenMaxLen * 2
        ) {
          const f1 = fitDirection(pts, p.i0, p.i1, 2);
          const f2 = fitDirection(pts, s.i0, s.i1, 2);
          if (f1 && f2) {
            const turn = vectorTurnDeg(f1.dx, f1.dy, f2.dx, f2.dy);
            if (turn < o.fitTurnMin) collinear = i;
          }
        }
      }
    }
    if (bridge !== -1) cur.splice(bridge, 1);
    else if (between !== -1) cur.splice(between, 1);
    else if (spike !== -1) cur.splice(spike, 1);
    else if (collinear !== -1) {
      // delete pseudo-peak: stitch both sides
      const stitched = stitch(cur[collinear - 1], cur[collinear]);
      cur.splice(collinear - 1, 2, stitched);
    } else if (firstShort !== -1) cur.splice(firstShort, 1);
    else break;
    cur = mergeSameDir(cur);
  }
  return cur;
}

// ================= 5. Single-stroke extraction =================

export const EMPTY = { sequence: "", segments: [], count: 0, empty: true };

/** One stroke -> segment list (no segment-count gate, no multi-stroke logic).
 *  Pipeline: DP de-noise -> resample -> corner-profile maxima (corners) ->
 *  segmentation -> pruning.
 *  With opts.debug = true the intermediate stages are attached to the result
 *  (for diagnostics/tests only). */
export function extractStrokeSegments(rawPoints, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!rawPoints || rawPoints.length < 2) return EMPTY;
  const step = Math.min(Math.max(0.5, o.resampleStep), 8);
  // Adaptive DP tolerance: the larger the estimated jitter, the larger the
  // tolerance (clamped so real corners are never swallowed).
  const sigma = estimateJitterSigma(rawPoints);
  const tol = Math.min(Math.max(o.simplifyTolerance, sigma * 5), o.simplifyTolerance * 1.6);
  const idxs = simplifyPolylineIdx(rawPoints, tol);
  const pts = resamplePolyline(idxs.map((i) => rawPoints[i]), step);
  if (pts.length < 2) return EMPTY;

  const { corners, turn } = detectCorners(pts, o);
  const segs = buildSegments(pts, cumulativeArcLengths(pts), corners, turn, o);
  if (segs.length === 0) return EMPTY;

  const kept = pruneSegments(segs, pts, o);
  if (kept.length === 0) return EMPTY;

  const result = {
    sequence: kept.map((s) => s.dir).join(""),
    segments: kept.map((s) => ({ dir: s.dir, length: Math.round(s.arc) })),
    count: kept.length,
    empty: false,
  };
  if (opts && opts.debug) {
    result._stages = {
      sigma,
      tol,
      keptIdx: idxs,
      pts: pts.map((p) => ({ x: p.x, y: p.y })),
      corners: corners.slice(),
      segmentsBeforePrune: segs.map((s) => ({ dir: s.dir, arc: s.arc, chord: s.chord })),
    };
  }
  return result;
}

// ================= 6. Pattern-level recognition =================

/** Aggregate per-stroke results into the final verdict (shared by full and
 *  incremental recognition). */
export function finalizeParts(parts, o) {
  const fail = (invalidReason, message, count) => ({
    valid: false,
    sequence: null,
    segments: [],
    count: count || 0,
    invalidReason,
    message,
  });

  let sequence = "";
  let segments = [];
  let count = 0;
  for (const p of parts) {
    sequence += p.sequence;
    segments = segments.concat(p.segments);
    count += p.count;
  }

  if (count === 0) return fail("empty", "Draw your pattern on the pad first.");
  if (count < o.minSegments) {
    return fail("too_few_segments", `Not enough segments: ${count}/${o.minSegments}`, count);
  }
  if (count > o.maxSegments) {
    return fail(
      "too_many_segments",
      `Pattern too complex (${count} segments); please simplify to ${o.maxSegments} or fewer.`,
      count,
    );
  }

  return {
    valid: true,
    sequence,
    segments,
    count,
    invalidReason: null,
    message: `Valid: ${segments.map((s) => DIR_ARROW[s.dir]).join("")} (${count} segments)`,
  };
}

/** Multi-stroke recognition: each stroke is processed independently, then the
 *  direction sequences are concatenated in draw order. Per-stroke thresholds
 *  are normalized to each stroke's own arc length; pen-up jumps between strokes
 *  cannot create phantom segments.
 *  @param {Array<Array<{x:number,y:number}>>} strokes
 *  @param {object} [opts] overrides of DEFAULTS
 *  @returns {{valid:boolean, sequence:string|null, segments:Array, count:number,
 *             invalidReason:string|null, message:string}} */
export function recognizeStrokes(strokes, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!strokes || strokes.length === 0) {
    return {
      valid: false,
      sequence: null,
      segments: [],
      count: 0,
      invalidReason: "empty",
      message: "Draw your pattern on the pad first.",
    };
  }
  const parts = [];
  for (const raw of strokes) parts.push(extractStrokeSegments(raw, o));
  return finalizeParts(parts, o);
}

/** Single-stroke recognition (compatibility helper). */
export function recognizeSequence(rawPoints, opts) {
  return recognizeStrokes([rawPoints], opts);
}

// ================= 7. Incremental recognition =================

/** Incremental recognizer: strokes already committed are extracted once and
 *  cached; every call recomputes only the stroke currently being drawn. While
 *  drawing a large pattern the per-frame cost drops from O(total points) to
 *  O(current stroke points). The partial stroke passed to result() acts as a
 *  preview and is not cached. */
export function createIncrementalRecognizer(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const parts = [];
  return {
    /** Commit a finished stroke. */
    addStroke(rawPoints) {
      parts.push(extractStrokeSegments(rawPoints, o));
    },
    /** Undo the last stroke. */
    removeLast() {
      parts.pop();
    },
    /** Clear everything. */
    clear() {
      parts.length = 0;
    },
    /** Current result: committed strokes + optional in-progress stroke (preview). */
    result(partialPoints) {
      if (partialPoints && partialPoints.length) {
        return finalizeParts(parts.concat([extractStrokeSegments(partialPoints, o)]), o);
      }
      return finalizeParts(parts, o);
    },
    /** Number of committed strokes. */
    get strokeCount() {
      return parts.length;
    },
  };
}
