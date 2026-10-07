//! recognition_wasm -- hand-drawn pattern recognition core (WebAssembly).
//!
//! Port of `htdocs/signature_recognition.js` (the reference implementation).
//! The pipeline: adaptive Douglas-Peucker de-noising -> uniform arc-length
//! resampling -> turn-angle profile local maxima (corners) -> segmentation ->
//! iterative pruning (bridge / between / spike / collinear / short).
//!
//! The JS glue (recognition_engine.js) writes points into WASM memory as a
//! flat f64 array [x0,y0,x1,y1,...] and calls [`extract_stroke`], which
//! returns a pointer to a `StrokeResult` (see ABI notes below). Output must be
//! bit-compatible in behavior with the JS reference; `test/recognition_test.mjs`
//! enforces exact parity (sequence, segment count, segment lengths).
//!
//! ABI (little-endian, no wasm-bindgen):
//!   alloc(size) -> *mut u8          |  dealloc(ptr, size)
//!   extract_stroke(ptr,n, opts...) -> *const StrokeResult  (24 bytes)
//!   StrokeResult { seq_ptr:u32 seq_len:u32 count:u32 valid:u8 empty:u8
//!                  seg_ptr:u32 seg_bytes:u32 }
//!   segments layout: count pairs of u32: [dir_code 0..7, rounded_length]
//!   dir codes: 0=R 1=RU 2=U 3=LU 4=L 5=LD 6=D 7=RD

use std::alloc::Layout;

const OCTANT_RATIO: f64 = 0.5;

/// Direction codes (ring order, matches DIR_INDEX in the JS reference).
const DIR_R: u8 = 0;

#[repr(C)]
pub struct StrokeResult {
    seq_ptr: u32,
    seq_len: u32,
    count: u32,
    valid: u8,
    empty: u8,
    seg_ptr: u32,
    seg_bytes: u32,
}

/// Owns the ABI struct plus the buffers it points into. Dropping the previous
/// `OwnedResult` on the next call frees the previous buffers (WASM is
/// single-threaded, so the global is sound).
struct OwnedResult {
    abi: StrokeResult,
    seq: Vec<u8>,
    seg_data: Vec<u32>,
}

/// The previous result allocation is freed on the next call (WASM is
/// single-threaded, so a global is sound here).
static mut LAST_RESULT: *mut OwnedResult = std::ptr::null_mut();

// ---------------------------------------------------------------------------
// WASM exports
// ---------------------------------------------------------------------------

/// Allocate `size` bytes with 8-byte alignment (for the JS side to fill).
#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let layout = Layout::from_size_align(size.max(1), 8).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

/// Free a buffer previously allocated by [`alloc`] (size must match).
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        let layout = Layout::from_size_align(size.max(1), 8).unwrap();
        unsafe { std::alloc::dealloc(ptr, layout) }
    }
}

/// Classify a displacement into one of 8 directions (exposed for tests).
#[no_mangle]
pub extern "C" fn classify_dir_f(dx: f64, dy: f64) -> u32 {
    classify_dir(dx, dy) as u32
}

/// Core single-stroke extraction (ABI described in the module docs).
/// Returns 0 when the stroke has fewer than 2 points.
///
/// # Safety
/// `pts` must point to `n` f64 pairs (x,y) in WASM memory; `n` must not
/// exceed the allocation.
#[no_mangle]
pub unsafe extern "C" fn extract_stroke(
    pts: *const f64,
    n: u32,
    simplify_tolerance: f64,
    resample_step: f64,
    corner_window: f64,
    corner_smooth: f64,
    min_corner_turn: f64,
    corner_gap: f64,
    min_leg_len: f64,
    min_point_step: f64,
    fit_turn_min: f64,
    between_max_len: f64,
    between_ratio: f64,
    between_strong: f64,
) -> *const StrokeResult {
    if n < 2 || pts.is_null() {
        return std::ptr::null();
    }
    let data = std::slice::from_raw_parts(pts, (n as usize) * 2);
    let points = RawPoints { data };

    let o = Options {
        simplify_tolerance,
        resample_step,
        corner_window,
        corner_smooth,
        min_corner_turn,
        corner_gap,
        min_leg_len,
        min_point_step,
        fit_turn_min,
        between_max_len,
        between_ratio,
        between_strong,
    };

    let result = extract_stroke_core(&points, &o);
    let mut owned = Box::new(OwnedResult {
        abi: result.0,
        seq: result.1,
        seg_data: result.2,
    });
    owned.abi.seq_ptr = owned.seq.as_ptr() as u32;
    owned.abi.seq_len = owned.seq.len() as u32;
    owned.abi.seg_ptr = owned.seg_data.as_ptr() as u32;
    owned.abi.seg_bytes = (owned.seg_data.len() * 4) as u32;

    // Free the previous result (the Vecs inside own their buffers).
    unsafe {
        if !LAST_RESULT.is_null() {
            drop(Box::from_raw(LAST_RESULT));
        }
        LAST_RESULT = Box::into_raw(owned);
        &(*LAST_RESULT).abi as *const StrokeResult
    }
}

// ---------------------------------------------------------------------------
// Options + point access
// ---------------------------------------------------------------------------

struct Options {
    simplify_tolerance: f64,
    resample_step: f64,
    corner_window: f64,
    corner_smooth: f64,
    min_corner_turn: f64,
    corner_gap: f64,
    min_leg_len: f64,
    min_point_step: f64,
    fit_turn_min: f64,
    between_max_len: f64,
    between_ratio: f64,
    between_strong: f64,
}

/// Read-only view over a raw f64 array of x,y pairs (no copying).
struct RawPoints<'a> {
    data: &'a [f64],
}

impl RawPoints<'_> {
    #[inline]
    fn len(&self) -> usize {
        self.data.len() / 2
    }
    #[inline]
    fn x(&self, i: usize) -> f64 {
        self.data[2 * i]
    }
    #[inline]
    fn y(&self, i: usize) -> f64 {
        self.data[2 * i + 1]
    }
}

/// Owned point list (resampled polyline).
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

struct Seg {
    i0: usize,
    i1: usize,
    dx: f64,
    dy: f64,
    chord: f64,
    arc: f64,
    dir: u8,
    tin: f64,
    tout: f64,
}

// ---------------------------------------------------------------------------
// 1. Basic geometry
// ---------------------------------------------------------------------------

/// IEEE sqrt-based 2D norm: exactly rounded in both JS (Math.sqrt) and Rust,
/// keeping the reference implementation and the WASM core bit-identical
/// (Math.hypot / libm hypot may differ by 1 ulp between engines).
#[inline]
fn hypot(a: f64, b: f64) -> f64 {
    (a * a + b * b).sqrt()
}

/// Displacement -> one of 8 directions (canvas y grows downward).
#[inline]
fn classify_dir(dx: f64, dy: f64) -> u8 {
    let ax = dx.abs();
    let ay = dy.abs();
    let ratio = ax.min(ay) / ax.max(ay);
    if ratio <= OCTANT_RATIO {
        if ax >= ay {
            if dx >= 0.0 { DIR_R } else { 4 /* L */ }
        } else if dy >= 0.0 {
            6 /* D */
        } else {
            2 /* U */
        }
    } else {
        let h = if dx >= 0.0 { 0 } else { 4 };
        let v = if dy >= 0.0 { 6 } else { 2 };
        // diagonal codes: RU=1, LU=3, LD=5, RD=7
        match (h, v) {
            (0, 2) => 1, // RU
            (4, 2) => 3, // LU
            (4, 6) => 5, // LD
            _ => 7,      // RD
        }
    }
}

/// Angle (0~180 deg) between vectors (ux,uy) and (vx,vy); 0 for zero vectors.
fn vector_turn_deg(ux: f64, uy: f64, vx: f64, vy: f64) -> f64 {
    let cross = ux * vy - uy * vx;
    let dot = ux * vx + uy * vy;
    if cross == 0.0 && dot == 0.0 {
        return 0.0;
    }
    (cross.abs().atan2(dot) * 180.0) / std::f64::consts::PI
}

/// Distance from (px,py) to the line through (ax,ay)-(bx,by).
fn point_line_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return hypot(px - ax, py - ay);
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
    hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ---------------------------------------------------------------------------
// 2. Preprocessing
// ---------------------------------------------------------------------------

/// Iterative Douglas-Peucker simplification; returns kept indices
/// (strictly increasing, including first/last).
fn simplify_polyline_idx(points: &RawPoints, epsilon: f64) -> Vec<usize> {
    let n = points.len();
    let mut keep = vec![false; n];
    if n <= 2 {
        return (0..n).collect();
    }
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let mut max_d = 0.0f64;
        let mut max_i = usize::MAX;
        for i in a + 1..b {
            let d = point_line_dist(points.x(i), points.y(i), points.x(a), points.y(a), points.x(b), points.y(b));
            if d > max_d {
                max_d = d;
                max_i = i;
            }
        }
        if max_i != usize::MAX && max_d > epsilon {
            keep[max_i] = true;
            stack.push((a, max_i));
            stack.push((max_i, b));
        }
    }
    (0..n).filter(|&i| keep[i]).collect()
}

/// Uniform arc-length resampling of a simplified polyline (raw point indices).
fn resample_polyline(points: &RawPoints, idxs: &[usize], step: f64) -> Vec<Point> {
    let s = if step > 0.0 { step } else { 2.0 };
    if idxs.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::new();
    out.push(Point { x: points.x(idxs[0]), y: points.y(idxs[0]) });
    let mut walked = 0.0f64; // arc length walked since the last output point
    for w in 1..idxs.len() {
        let ax = points.x(idxs[w - 1]);
        let ay = points.y(idxs[w - 1]);
        let bx = points.x(idxs[w]);
        let by = points.y(idxs[w]);
        let dx = bx - ax;
        let dy = by - ay;
        let seg_len = hypot(dx, dy);
        if seg_len == 0.0 {
            continue;
        }
        let mut t = 0.0f64;
        while walked + (seg_len - t) >= s {
            t += s - walked;
            let r = t / seg_len;
            out.push(Point { x: ax + dx * r, y: ay + dy * r });
            walked = 0.0;
        }
        walked += seg_len - t;
    }
    let last_x = points.x(idxs[idxs.len() - 1]);
    let last_y = points.y(idxs[idxs.len() - 1]);
    let tail = out[out.len() - 1];
    if tail.x != last_x || tail.y != last_y {
        out.push(Point { x: last_x, y: last_y });
    }
    out
}

/// Deterministic quickselect (k-th order statistic, O(n) average).
/// Hoare partition with the middle pivot; returns the same VALUE as a full
/// sort (k-th order statistic), so it preserves exact JS/WASM parity with the
/// reference implementation while avoiding the O(n log n) sort on every frame.
fn select_kth(arr: &mut [f64], k: usize) -> f64 {
    let mut lo = 0usize;
    let mut hi = arr.len() - 1;
    loop {
        if lo >= hi {
            return arr[lo];
        }
        let pivot = arr[(lo + hi) >> 1];
        let mut i = lo;
        let mut j = hi;
        while i <= j {
            while arr[i] < pivot {
                i += 1;
            }
            while arr[j] > pivot {
                j -= 1;
            }
            if i <= j {
                arr.swap(i, j);
                i += 1;
                j -= 1;
            }
        }
        if k <= j {
            hi = j;
        } else if k >= i {
            lo = i;
        } else {
            return arr[k];
        }
    }
}

/// Jitter amplitude estimate: 25th percentile of |second difference| / 2.
fn estimate_jitter_sigma(points: &RawPoints) -> f64 {
    let n = points.len();
    if n < 8 {
        return 0.0;
    }
    let mut diffs: Vec<f64> = (1..n - 1)
        .map(|i| {
            let dx = points.x(i - 1) - 2.0 * points.x(i) + points.x(i + 1);
            let dy = points.y(i - 1) - 2.0 * points.y(i) + points.y(i + 1);
            hypot(dx, dy) / 2.0
        })
        .collect();
    let k = ((diffs.len() as f64) * 0.25).floor() as usize;
    select_kth(&mut diffs, k) / 0.925
}

/// Cumulative path arc lengths (O(1) arc queries).
fn cumulative_arc_lengths(pts: &[Point]) -> Vec<f64> {
    let n = pts.len();
    let mut cum = vec![0.0f64; n];
    for i in 1..n {
        cum[i] = cum[i - 1] + hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    cum
}

// ---------------------------------------------------------------------------
// 3. Corner detection
// ---------------------------------------------------------------------------

/// Local maxima of the turn-angle profile (see JS reference for rationale).
/// Returns (corners incl. first/last, smoothed profile).
fn detect_corners(pts: &[Point], o: &Options) -> (Vec<usize>, Vec<f64>) {
    let n = pts.len();
    let k = ((o.corner_window / o.resample_step).round() as i64).max(2) as usize;
    if n < 2 * k + 1 {
        return (vec![0, n - 1], vec![0.0; n]);
    }
    let mut turn = vec![0.0f64; n];
    for i in k..=n - 1 - k {
        turn[i] = vector_turn_deg(
            pts[i].x - pts[i - k].x,
            pts[i].y - pts[i - k].y,
            pts[i + k].x - pts[i].x,
            pts[i + k].y - pts[i].y,
        );
    }
    // Profile smoothing: +-H points (vertex jitter amplifies turn angles).
    let h = ((((o.corner_smooth as i32) - 1) >> 1).max(1)) as usize;
    let mut t = vec![0.0f64; n];
    {
        let mut pref = vec![0.0f64; n + 1];
        for i in 0..n {
            pref[i + 1] = pref[i] + turn[i];
        }
        for i in 0..n {
            let lo = (i.saturating_sub(h)) + 1;
            let hi = n.min(i + h + 1);
            t[i] = (pref[hi] - pref[lo - 1]) / ((hi - lo + 1) as f64);
        }
    }
    let min_turn = o.min_corner_turn;
    let min_gap = ((o.corner_gap / o.resample_step).round() as i64).max(1) as usize;
    let mut corners: Vec<usize> = Vec::new();
    for i in k..=n - 1 - k {
        if t[i] < min_turn {
            continue;
        }
        // local maximum (plateau: take left end)
        if t[i] <= t[i - 1] || t[i] < t[i + 1] {
            continue;
        }
        if let Some(&last) = corners.last() {
            if i - last <= min_gap {
                if t[i] > t[last] {
                    *corners.last_mut().unwrap() = i;
                }
            } else {
                corners.push(i);
            }
        } else {
            corners.push(i);
        }
    }
    let mut full = Vec::with_capacity(corners.len() + 2);
    full.push(0);
    full.extend_from_slice(&corners);
    full.push(n - 1);
    (full, t)
}

// ---------------------------------------------------------------------------
// 4. Segmentation and pruning
// ---------------------------------------------------------------------------

/// Whether `dir` lies strictly between `a` and `b` on the short ring arc.
fn is_between_mid(dir: u8, a: u8, b: u8) -> bool {
    if a == b {
        return false;
    }
    let f = |x: u8, y: u8| (y + 8 - x) % 8;
    let arc = f(a, b);
    if arc <= 4 {
        return f(a, dir) > 0 && f(a, dir) < arc;
    }
    let back = 8 - arc;
    f(dir, a) > 0 && f(dir, a) < back
}

/// Number of direction steps on the short arc between a and b (1..=4).
fn short_arc_steps(a: u8, b: u8) -> i32 {
    let f = |x: u8, y: u8| (y + 8 - x) % 8;
    let arc = f(a, b);
    let back = 8 - arc;
    arc.min(back) as i32
}

/// Least-squares principal direction of pts[i0..=i1] with a margin removed at
/// both ends; unit vector oriented along the chord head-to-tail.
fn fit_direction(pts: &[Point], i0: usize, i1: usize, margin: usize) -> Option<(f64, f64)> {
    let lo = i0 + margin;
    let hi = i1 - margin;
    let cnt = hi - lo + 1;
    if cnt < 4 {
        return None;
    }
    let (mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for i in lo..=hi {
        let x = pts[i].x;
        let y = pts[i].y;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    }
    let mx = sx / cnt as f64;
    let my = sy / cnt as f64;
    let vxx = sxx - cnt as f64 * mx * mx;
    let vyy = syy - cnt as f64 * my * my;
    let vxy = sxy - cnt as f64 * mx * my;
    let ang = 0.5 * (2.0 * vxy).atan2(vxx - vyy);
    let (mut dx, mut dy) = (ang.cos(), ang.sin());
    let fx = pts[hi].x - pts[lo].x;
    let fy = pts[hi].y - pts[lo].y;
    if dx * fx + dy * fy < 0.0 {
        dx = -dx;
        dy = -dy;
    }
    Some((dx, dy))
}

/// Build segments between adjacent corners.
fn build_segments(pts: &[Point], cum: &[f64], corners: &[usize], turn: &[f64], o: &Options) -> Vec<Seg> {
    let mut segs = Vec::new();
    for j in 1..corners.len() {
        let i0 = corners[j - 1];
        let i1 = corners[j];
        if i1 <= i0 {
            continue;
        }
        let dx = pts[i1].x - pts[i0].x;
        let dy = pts[i1].y - pts[i0].y;
        let chord = hypot(dx, dy);
        if chord < o.min_point_step {
            continue; // degenerate
        }
        let dir = match fit_direction(pts, i0, i1, 1) {
            Some((fx, fy)) => classify_dir(fx, fy),
            None => classify_dir(dx, dy),
        };
        segs.push(Seg {
            i0,
            i1,
            dx,
            dy,
            chord,
            arc: cum[i1] - cum[i0],
            dir,
            tin: turn[i0],
            tout: turn[i1],
        });
    }
    segs
}

/// Merge adjacent same-direction segments (mutates the first in place).
fn merge_same_dir(list: &mut Vec<Seg>) {
    let mut out: Vec<Seg> = Vec::with_capacity(list.len());
    for s in list.drain(..) {
        if let Some(last) = out.last_mut() {
            if last.dir == s.dir {
                last.dx += s.dx;
                last.dy += s.dy;
                last.chord = hypot(last.dx, last.dy);
                last.arc += s.arc;
                last.i1 = s.i1;
                continue;
            }
        }
        out.push(s);
    }
    *list = out;
}

/// Delete the corner between two segments and stitch them.
fn stitch(a: &Seg, b: &Seg) -> Seg {
    let dx = a.dx + b.dx;
    let dy = a.dy + b.dy;
    let chord = hypot(dx, dy);
    // A zero (or sub-step) net displacement is a classification trap:
    // classify_dir(0,0) would yield an arbitrary diagonal. Fall back to the
    // direction of the longer half (the shorter one is the noise vertex).
    // Mirrors the JS reference implementation exactly.
    let dir = if chord >= 2.0 {
        classify_dir(dx, dy)
    } else if a.chord >= b.chord {
        a.dir
    } else {
        b.dir
    };
    Seg {
        i0: a.i0,
        i1: b.i1,
        dx,
        dy,
        chord,
        arc: a.arc + b.arc,
        dir,
        tin: a.tin,
        tout: b.tout,
    }
}

/// Iterative pruning: one deletion per round, then re-merge (see JS reference).
/// Priority: bridge, between, spike (reversal outside the neighbors' short
/// fan -- a DP artifact at junctions), collinear, short.
fn prune_segments(list: Vec<Seg>, pts: &[Point], o: &Options) -> Vec<Seg> {
    let mut cur = list;
    merge_same_dir(&mut cur);
    loop {
        let mut bridge: Option<usize> = None;
        let mut between: Option<usize> = None;
        let mut spike: Option<usize> = None;
        let mut collinear: Option<usize> = None;
        let mut first_short: Option<usize> = None;
        for i in 0..cur.len() {
            let s = &cur[i];
            let short = s.chord < o.min_point_step || s.arc < o.min_leg_len;
            if short && first_short.is_none() {
                first_short = Some(i);
            }
            if i == 0 || i == cur.len() - 1 {
                continue;
            }
            let p = &cur[i - 1];
            let n = &cur[i + 1];
            let len_cap = (o.between_max_len).max(o.between_ratio * p.arc.min(n.arc));
            if short && bridge.is_none() && p.dir == n.dir {
                bridge = Some(i);
            }
            if between.is_none()
                && is_between_mid(s.dir, p.dir, n.dir)
                && s.arc < len_cap
                && s.tin.max(s.tout) >= o.between_strong
            {
                between = Some(i);
            }
            if spike.is_none()
                && p.dir != n.dir
                && short_arc_steps(p.dir, n.dir) <= 3
                && !is_between_mid(s.dir, p.dir, n.dir)
                && s.arc < len_cap
            {
                spike = Some(i);
            }
            if collinear.is_none()
                && s.chord >= o.min_point_step
                && s.arc < o.between_max_len * 2.0
            {
                if let (Some((f1x, f1y)), Some((f2x, f2y))) =
                    (fit_direction(pts, p.i0, p.i1, 2), fit_direction(pts, s.i0, s.i1, 2))
                {
                    if vector_turn_deg(f1x, f1y, f2x, f2y) < o.fit_turn_min {
                        collinear = Some(i);
                    }
                }
            }
        }
        if let Some(i) = bridge {
            cur.remove(i);
        } else if let Some(i) = between {
            cur.remove(i);
        } else if let Some(i) = spike {
            cur.remove(i);
        } else if let Some(i) = collinear {
            let stitched = stitch(&cur[i - 1], &cur[i]);
            cur.splice(i - 1..=i, [stitched]);
        } else if let Some(i) = first_short {
            cur.remove(i);
        } else {
            break;
        }
        merge_same_dir(&mut cur);
    }
    cur
}

// ---------------------------------------------------------------------------
// 5. Core pipeline (one stroke)
// ---------------------------------------------------------------------------

fn extract_stroke_core(points: &RawPoints, o: &Options) -> (StrokeResult, Vec<u8>, Vec<u32>) {
    // Adaptive DP tolerance: grows with estimated jitter (clamped).
    let sigma = estimate_jitter_sigma(points);
    let tol = (o.simplify_tolerance.max(sigma * 5.0)).min(o.simplify_tolerance * 1.6);
    let idxs = simplify_polyline_idx(points, tol);
    let step = o.resample_step.clamp(0.5, 8.0);
    let pts = resample_polyline(points, &idxs, step);
    if pts.len() < 2 {
        return (empty_result(), Vec::new(), Vec::new());
    }
    let (corners, turn) = detect_corners(&pts, o);
    let cum = cumulative_arc_lengths(&pts);
    let segs = build_segments(&pts, &cum, &corners, &turn, o);
    if segs.is_empty() {
        return (empty_result(), Vec::new(), Vec::new());
    }
    let kept = prune_segments(segs, &pts, o);
    if kept.is_empty() {
        return (empty_result(), Vec::new(), Vec::new());
    }

    let mut seq = Vec::with_capacity(kept.len() * 2);
    let mut seg_data = Vec::with_capacity(kept.len() * 2);
    for s in &kept {
        let name = dir_name(s.dir);
        seq.extend_from_slice(name.as_bytes());
        seg_data.push(s.dir as u32);
        seg_data.push((s.arc + 0.5).floor() as u32);
    }
    let count = kept.len() as u32;
    let result = StrokeResult {
        seq_ptr: 0,
        seq_len: 0,
        count,
        valid: 1,
        empty: 0,
        seg_ptr: 0,
        seg_bytes: 0,
    };
    (result, seq, seg_data)
}

fn empty_result() -> StrokeResult {
    StrokeResult {
        seq_ptr: 0,
        seq_len: 0,
        count: 0,
        valid: 0,
        empty: 1,
        seg_ptr: 0,
        seg_bytes: 0,
    }
}

fn dir_name(dir: u8) -> &'static str {
    const NAMES: [&str; 8] = ["R", "RU", "U", "LU", "L", "LD", "D", "RD"];
    NAMES[(dir as usize) % 8]
}
