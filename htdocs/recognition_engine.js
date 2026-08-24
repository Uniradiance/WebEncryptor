// recognition_engine.js — WASM-accelerated signature recognition engine.
//
// Loads the Rust-built recognition_wasm.wasm and exposes the same public API
// as signature_recognition.js (the pure-JS reference). The JS reference stays
// as an exact-parity fallback when WebAssembly is unavailable or still
// loading, so the recognized chain code never depends on load timing:
// test/recognition_test.mjs enforces JS <-> WASM output equality.
//
// The heavy per-stroke core (DP simplification, resampling, corner profile,
// pruning) runs in Rust; aggregation/messaging and the incremental cache stay
// in JS. The WASM core processes raw points in place (shared linear memory),
// so no per-frame object allocation is needed in the hot path.

import * as REF from "./signature_recognition.js";

// Single source of truth for the direction alphabet (imported from the reference).
const DIRS = REF.DIRS;
const textDecoder = new TextDecoder();

let wasm = null;
let status = "loading"; // loading | wasm | js

// --- wasm bootstrap (browser: streaming fetch; node: fs for tests) ---
async function loadWasm() {
  const url = new URL("./recognition_wasm.wasm", import.meta.url);
  try {
    let instance;
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      const { readFileSync } = await import("node:fs");
      const bytes = readFileSync(url);
      ({ instance } = await WebAssembly.instantiate(bytes, {}));
    } else if (typeof WebAssembly.instantiateStreaming === "function") {
      ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), {}));
    } else {
      const resp = await fetch(url);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      ({ instance } = await WebAssembly.instantiate(bytes, {}));
    }
    wasm = instance.exports;
    status = "wasm";
  } catch (err) {
    console.warn("recognition_wasm.wasm unavailable; using JS fallback:", err && err.message ? err.message : err);
    wasm = null;
    status = "js";
  }
}
const readyPromise = loadWasm();

// --- shared point buffer (grows only) ---
let bufPtr = 0;
let bufCap = 0; // in points

function ensureBuf(n) {
  if (n > bufCap) {
    if (bufPtr !== 0) wasm.dealloc(bufPtr, bufCap * 16);
    bufCap = Math.max(64, n + 64);
    bufPtr = wasm.alloc(bufCap * 16);
  }
  return bufPtr;
}

/** Run the Rust core over raw points with effective options. */
function extractWasm(rawPoints, o) {
  const n = rawPoints.length;
  const ptr = ensureBuf(n);
  // Re-create the view each call: the ArrayBuffer may be detached/regrown by
  // wasm allocation beyond linear-memory growth.
  const view = new Float64Array(wasm.memory.buffer, ptr, n * 2);
  for (let i = 0; i < n; i++) {
    view[i * 2] = rawPoints[i].x;
    view[i * 2 + 1] = rawPoints[i].y;
  }
  const resPtr = wasm.extract_stroke(
    ptr,
    n,
    o.simplifyTolerance,
    o.resampleStep,
    o.cornerWindow,
    o.cornerSmooth,
    o.minCornerTurn,
    o.cornerGap,
    o.minLegLen,
    o.minPointStep,
    o.fitTurnMin,
    o.betweenMaxLen,
    o.betweenRatio,
    o.betweenStrong,
  );
  if (resPtr === 0) return REF.EMPTY;
  const dv = new DataView(wasm.memory.buffer, resPtr, 24);
  const seqPtr = dv.getUint32(0, true);
  const seqLen = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const empty = dv.getUint8(13, true) !== 0;
  const segPtr = dv.getUint32(16, true);
  if (count === 0) return REF.EMPTY;
  const sequence = textDecoder.decode(new Uint8Array(wasm.memory.buffer, seqPtr, seqLen));
  const segDv = new DataView(wasm.memory.buffer, segPtr, count * 8);
  const segments = new Array(count);
  for (let i = 0; i < count; i++) {
    segments[i] = {
      dir: DIRS[segDv.getUint8(i * 8)],
      length: segDv.getUint32(i * 8 + 4, true),
    };
  }
  return { sequence, segments, count, empty };
}

/** Public core: WASM when ready, otherwise the parity JS reference. */
export function extractStrokeSegments(rawPoints, opts) {
  const o = Object.assign({}, REF.DEFAULTS, opts || {});
  if (!rawPoints || rawPoints.length < 2) return REF.EMPTY;
  if (wasm) return extractWasm(rawPoints, o);
  return REF.extractStrokeSegments(rawPoints, o);
}

/** Pattern-level recognition (aggregation lives in JS). */
export function finalizeParts(parts, o) {
  return REF.finalizeParts(parts, o);
}

/** Multi-stroke recognition (WASM-accelerated, same semantics). */
export function recognizeStrokes(strokes, opts) {
  const o = Object.assign({}, REF.DEFAULTS, opts || {});
  if (!strokes || strokes.length === 0) return REF.finalizeParts([], o);
  const parts = [];
  for (const raw of strokes) parts.push(extractStrokeSegments(raw, o));
  return REF.finalizeParts(parts, o);
}

/** Single-stroke recognition (compatibility helper). */
export function recognizeSequence(rawPoints, opts) {
  return recognizeStrokes([rawPoints], opts);
}

/** Incremental recognizer: committed strokes cached, current stroke only
 *  recomputed per frame (WASM-accelerated). */
export function createIncrementalRecognizer(opts) {
  const o = Object.assign({}, REF.DEFAULTS, opts || {});
  const parts = [];
  return {
    addStroke(rawPoints) {
      parts.push(extractStrokeSegments(rawPoints, o));
    },
    removeLast() {
      parts.pop();
    },
    clear() {
      parts.length = 0;
    },
    result(partialPoints) {
      if (partialPoints && partialPoints.length) {
        return REF.finalizeParts(parts.concat([extractStrokeSegments(partialPoints, o)]), o);
      }
      return REF.finalizeParts(parts, o);
    },
    get strokeCount() {
      return parts.length;
    },
  };
}

/** Awaitable + status helpers (tests wait for readiness). */
export const whenReady = readyPromise;
export function engineStatus() {
  return status;
}

export const DEFAULTS = REF.DEFAULTS;
export const DIR_ARROW = REF.DIR_ARROW;
export const EMPTY = REF.EMPTY;
