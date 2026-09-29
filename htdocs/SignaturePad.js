import { encodePattern } from './pattern_encoding.js';

// SignaturePad.js — elongated hand-drawn pattern pad (factor C).
//
// Canvas -> multi-stroke accumulation -> 8-direction chain code recognition
// (recognition_engine.js, Rust/WASM accelerated with a parity JS fallback) ->
// direction-canonical segment codes, fed to the crypto worker as rulePhrase.
//
// Interaction:
//   - Multiple pen-down strokes accumulate onto the same pattern (each stroke
//     is recognized as it completes; keep drawing to append).
//   - Undo removes the last stroke; Clear redraws everything; Confirm erases
//     the ink and stamps the pad (the recognized sequence stays cached for
//     encryption).
//   - Privacy: when valid, the feedback line shows direction arrows; 5 s after
//     the last stroke it is masked to a fixed number of asterisks. The eye
//     button (left of Undo) toggles "always show": direction arrows stay drawn
//     on the strokes and the feedback stays unmasked.
//   - Live feedback: valid / too few segments — visible immediately.
//
// Performance: an offscreen canvas holds the committed strokes (drawn once per
// stroke), so per-frame redraws blit it instead of re-tracing every committed
// polyline; the incremental recognizer only recomputes the stroke in progress.
//
// State invariant: 'strokes' is the single source of truth for the pattern.
// The recognition cache is rebuilt from it whenever a mutation happens
// (undo/clear) or a stroke commit fails, so the feedback sequence and the
// canvas can never drift apart (no 'phantom' stroke that is visible but
// unrecorded, and no undo-off-by-one).

import {
  createIncrementalRecognizer,
  DIR_ARROW,
} from "./recognition_engine.js";

// 5 s without a new stroke -> mask the direction arrows
const HIDE_DELAY_MS = 5000;
// Fixed number of asterisks used for masking / signed state
const MASKED_DOTS = "*".repeat(18);

export function createSignaturePad(container, options = {}) {
  const minSegments = options.minSegments ?? 1;
  const height = options.height ?? 195; // CSS px

  container.innerHTML = `
        <div class="sigpad">
            <p class="sigpad-help">Use the grid as a guide. Keep turns clear and legs long. Start markers show stroke order.</p>
            <div class="sigpad-stage">
                <canvas class="sigpad-canvas"></canvas>
                <div class="sigpad-stamp" hidden>SIGNED</div>
            </div>
            <div class="sigpad-toolbar">
                <span role="status" aria-live="polite" class="sigpad-feedback">Draw your pattern on the pad.</span>
                <span class="sigpad-actions">
                    <button type="button" class="toggle-rule-button sigpad-directions-toggle" id="toggleRuleEncrypt" title="Always show stroke directions" aria-label="Always show stroke directions" aria-pressed="false">
                        <svg class="eye-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button>
                    <button type="button" class="sigpad-undo" title="Undo the last stroke" aria-label="Undo the last stroke">
                    <svg t="1787562257241" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="20463" width="32" height="32"><path d="M170.666667 469.333333a42.666667 42.666667 0 0 0-42.666667 42.666667 42.666667 42.666667 0 0 0 42.666667 42.666667h512c71.210667 0 128 56.789333 128 128v85.333333a42.666667 42.666667 0 0 0 42.666666 42.666667 42.666667 42.666667 0 0 0 42.666667-42.666667v-85.333333c0-117.333333-96-213.333333-213.333333-213.333334z" p-id="20464"></path><path d="M384 256a42.666667 42.666667 0 0 0-30.165333 12.501333l-213.333334 213.333334a42.666667 42.666667 0 0 0 0 60.330666l213.333334 213.333334a42.666667 42.666667 0 0 0 60.330666 0 42.666667 42.666667 0 0 0 0-60.330667L230.997333 512l183.168-183.168a42.666667 42.666667 0 0 0 0-60.330667A42.666667 42.666667 0 0 0 384 256z" p-id="20465"></path></svg>
                    </button>
                    <button type="button" class="sigpad-clear" title="Clear everything and redraw" aria-label="Clear everything and redraw">
                        <svg t="1787562970259" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="10510" width="32" height="32"><path d="M634.5728 118.1184l319.3856 320.0512a75.5712 75.5712 0 0 1 0 106.7008l-318.464 319.1296h308.48a32 32 0 0 1 4.7616 63.6416l-4.7616 0.3584H80.0256a32 32 0 0 1-4.7104-63.6416l4.7616-0.3584h231.6288l-209.8688-212.48a75.5712 75.5712 0 0 1 0.256-106.3936l426.0864-427.008a75.1616 75.1616 0 0 1 106.496 0zM282.112 455.2704L147.4048 590.336a11.5712 11.5712 0 0 0-1.8944 13.824l1.8432 2.4064 254.2592 257.3824h143.616l73.8816-74.0864L282.112 455.2704z" fill="#1D2129" p-id="10511"></path></svg>
                    </button>
                    <button type="button" class="sigpad-verify" disabled>Redraw to verify</button>
                    <button type="button" class="sigpad-cancel-verify" hidden>Cancel verification</button>
                    <button type="button" class="sigpad-confirm" title="Confirm: erase the ink and stamp the pad" disabled>Confirm</button>
                </span>
            </div>
        </div>`;

  const sigpadEl = container.querySelector(".sigpad");
  const canvas = container.querySelector(".sigpad-canvas");
  const stamp = container.querySelector(".sigpad-stamp");
  const feedback = container.querySelector(".sigpad-feedback");
  const undoBtn = container.querySelector(".sigpad-undo");
  const clearBtn = container.querySelector(".sigpad-clear");
  const confirmBtn = container.querySelector(".sigpad-confirm");
  const verifyBtn = container.querySelector('.sigpad-verify');
  const cancelVerifyBtn = container.querySelector('.sigpad-cancel-verify');
  const dirToggleBtn = container.querySelector(".sigpad-directions-toggle");
  const ctx = canvas.getContext("2d");

  let strokes = []; // committed strokes: Array<Array<{x,y}>> (kept in sync with rec)
  let current = null; // stroke in progress
  let drawing = false;
  let lastResult = null;
  let rafPending = false;
  let signed = false;
  let feedbackMasked = false;
  let showDirections = false; // eye toggle: keep stroke-direction arrows visible
  let hideTimer = null;
  let locked = false;
  let baseline = null;
  let verifiedCode = null;

  // Offscreen canvas holding the committed strokes (redraw cache)
  const offscreen = document.createElement("canvas");
  const offCtx = offscreen.getContext("2d");

  // Incremental recognizer: committed strokes cached, only the current stroke
  // is recomputed per frame.
  // 'options.recognizer' is a test-only factory hook (e.g. to inject extraction
  // failures); the default builds the real engine.
  const rec = (options.recognizer || createIncrementalRecognizer)({ minSegments });

  // --- canvas sizing (devicePixelRatio aware) ---
  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.height = height + "px";
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // re-render committed strokes (+ direction arrows, when toggled on) on the offscreen cache
    renderOffscreen();
    redraw();
  };

  const drawPolyline = (c, pts, strokeNumber) => {
    if (!pts || pts.length < 2) return;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.strokeStyle = "#1f2937";
    c.lineWidth = 3;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.stroke();
    c.beginPath();
    c.arc(pts[0].x, pts[0].y, 9, 0, Math.PI * 2);
    c.fillStyle = '#15803d';
    c.fill();
    c.fillStyle = '#fff';
    c.font = '12px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(strokeNumber), pts[0].x, pts[0].y);
  };

  // Small filled arrowheads every `spacing` px along the polyline, pointing in
  // the drawing direction (the "eye" toggle shows stroke direction on the pad).
  const drawDirectionArrows = (c, pts) => {
    if (!pts || pts.length < 2) return;
    const spacing = 30; // px between arrowheads
    const size = 6.5; // arrowhead size
    c.fillStyle = "#2563eb";
    let carry = spacing; // arc distance left until the next arrowhead
    let prev = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) continue;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;
      let d = 0; // arc walked along this edge
      while (d + carry <= len) {
        d += carry;
        const x = prev.x + ux * d;
        const y = prev.y + uy * d;
        c.beginPath();
        c.moveTo(x + ux * size, y + uy * size); // tip
        c.lineTo(x - ux * size + px * size * 0.55, y - uy * size + py * size * 0.55);
        c.lineTo(x - ux * size - px * size * 0.55, y - uy * size - py * size * 0.55);
        c.closePath();
        c.fill();
        carry = spacing;
      }
      carry -= len - d;
      prev = p;
    }
  };

  // Rebuild the offscreen redraw cache: committed ink (+ direction arrows when
  // the eye toggle is on). Keeps per-frame redraws a cheap blit.
  const renderOffscreen = () => {
    offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      drawPolyline(offCtx, s, i + 1);
      if (showDirections) drawDirectionArrows(offCtx, s);
    }
  };

  // Redraw = blit the committed-stroke cache + the stroke in progress (cheap:
  // cost is O(current stroke), not O(all strokes)).
  const redraw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!signed) {
      ctx.drawImage(offscreen, 0, 0);
    }
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!signed) {
      if (current) drawPolyline(ctx, current, strokes.length + 1);
      if (showDirections && current) drawDirectionArrows(ctx, current);
    }
  };

  const toCssPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const updateFeedback = () => {
    const r = lastResult;
    if (baseline !== null) {
      const matches = r && r.valid && encodePattern(r.segments) === baseline;
      feedback.textContent = matches ? 'Redraw matches. Click Confirm match.' :
        r && r.valid ? 'Pattern differs. Undo or clear and try again.' : 'Draw the same pattern again, in the same direction and order.';
      feedback.className = matches ? 'sigpad-feedback ok' : 'sigpad-feedback';
    } else if (verifiedCode !== null) {
      feedback.textContent = 'Pattern verified. Ready to encrypt.';
      feedback.className = 'sigpad-feedback ok';
    } else if (signed) {
      feedback.textContent = MASKED_DOTS;
      feedback.className = "sigpad-feedback masked";
      feedbackMasked = false;
    } else if (!r) {
      feedback.textContent =
        "Draw your pattern on the pad.";
      feedback.className = "sigpad-feedback";
      feedbackMasked = false;
    } else if (r.valid) {
      feedback.textContent = feedbackMasked ? MASKED_DOTS : r.message;
      feedback.className = feedbackMasked ? "sigpad-feedback masked" : "sigpad-feedback ok";
    } else {
      feedback.textContent = r.message;
      feedback.className = "sigpad-feedback err";
      feedbackMasked = false;
    }
    undoBtn.disabled = locked || signed || (strokes.length === 0 && !drawing);
    clearBtn.disabled = locked; // clear works even after confirm (equivalent to undoing it)
    confirmBtn.disabled = locked || baseline !== null || !(r && r.valid && !signed) || drawing;
    verifyBtn.disabled = locked || drawing || !(r && r.valid);
    verifyBtn.textContent = baseline !== null ? 'Confirm match' : verifiedCode !== null ? 'Verify again' : 'Redraw to verify';
    cancelVerifyBtn.hidden = baseline === null;
    cancelVerifyBtn.disabled = locked;
  };

  const compute = () => {
    lastResult = rec.result(current);
    if (!signed) verifiedCode = null;
    updateFeedback();
  };

  const scheduleCompute = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      compute();
    });
  };

  const cancelHide = () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const scheduleHide = () => {
    cancelHide();
    // Eye toggle on: keep the direction arrows visible (no privacy masking).
    if (showDirections || signed) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (signed) return;
      feedbackMasked = true;
      updateFeedback();
    }, HIDE_DELAY_MS);
  };

  const revealFeedback = () => {
    cancelHide();
    if (feedbackMasked) {
      feedbackMasked = false;
      updateFeedback();
    }
  };

  // Rebuild the recognition cache from 'strokes' (the single source of truth
  // for the pattern). Keeps the recognizer in sync no matter what happened
  // before (e.g. a failed commit); cheap: only runs on undo/clear/commit-fail.
  const resyncRec = () => {
    rec.clear();
    for (const s of strokes) {
      try {
        rec.addStroke(s);
      } catch (err) {
        // The engine never throws (it normalizes to EMPTY). Last resort; keep
        // the remaining strokes recognizable.
        console.warn('signature pad: failed to re-recognize a stroke', err);
      }
    }
  };

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (locked || drawing || signed) return;
    revealFeedback();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    current = [toCssPoint(e)];
    redraw();
    updateFeedback();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing || !current) return;
    const p = toCssPoint(e);
    const last = current[current.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1) return; // sub-pixel de-noise
    current.push(p);
    redraw();
    scheduleCompute();
  });

  const endStroke = () => {
    if (!drawing || !current) return;
    drawing = false;
    const s = current; // capture; commit is all-or-nothing below
    current = null;
    strokes.push(s); // accumulate: the next stroke appends to the pattern
    try {
      rec.addStroke(s); // commit: result enters the cache (engine never throws)
    } catch (err) {
      // Safety net: rebuild the cache from 'strokes' so the recognizer stays
      // in sync even after an interrupted commit (no phantom stroke).
      console.warn('signature pad: stroke commit failed; resyncing', err);
      resyncRec();
    }
    drawPolyline(offCtx, s, strokes.length); // update the redraw cache once
    if (showDirections) drawDirectionArrows(offCtx, s);
    compute();
    scheduleHide();
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  undoBtn.addEventListener("click", () => {
    if (locked || drawing || signed) return;
    strokes.pop();
    resyncRec(); // 'strokes' is the source of truth: heals any prior drift
    renderOffscreen();
    redraw();
    compute();
    revealFeedback();
    scheduleHide();
  });

  clearBtn.addEventListener("click", () => {
    if (locked) return;
    verifiedCode = null;
    strokes = [];
    current = null;
    drawing = false;
    lastResult = null;
    signed = false;
    feedbackMasked = false;
    cancelHide();
    sigpadEl.classList.remove("signed");
    stamp.hidden = true;
    resyncRec(); // strokes is empty -> clears the recognition cache too
    renderOffscreen();
    redraw();
    updateFeedback();
  });

  // Confirm: erase the ink, stamp the pad (the sequence stays cached for use)
  confirmBtn.addEventListener("click", () => {
    const r = lastResult;
    if (locked || drawing || baseline !== null || !r || !r.valid || signed) return;
    signed = true;
    cancelHide();
    feedbackMasked = false;
    strokes = []; // visually erase (rec cache keeps the sequence for getSequence)
    current = null;
    drawing = false;
    sigpadEl.classList.add("signed");
    redraw();
    stamp.hidden = false;
    updateFeedback();
  });

  verifyBtn.addEventListener('click', () => {
    if (locked || drawing || !lastResult || !lastResult.valid) return;
    const code = encodePattern(lastResult.segments);
    if (baseline === null) {
      baseline = code;
      clearBtn.click();
      updateFeedback();
    } else if (code === baseline) {
      verifiedCode = code;
      baseline = null;
      updateFeedback(); // enable the native Confirm button before clicking it
      confirmBtn.click();
      updateFeedback();
    } else {
      updateFeedback();
    }
  });
  cancelVerifyBtn.addEventListener('click', () => {
    if (locked) return;
    baseline = null;
    clearBtn.click();
  });

  // Eye toggle: always show stroke directions on the pad (no 5 s masking)
  dirToggleBtn.addEventListener("click", () => {
    showDirections = !showDirections;
    dirToggleBtn.classList.toggle("active", showDirections);
    dirToggleBtn.setAttribute("aria-pressed", String(showDirections));
    dirToggleBtn.title = showDirections ? "Hide stroke directions" : "Always show stroke directions";
    dirToggleBtn.setAttribute("aria-label", dirToggleBtn.title);
    if (showDirections) {
      cancelHide();
      if (feedbackMasked) {
        feedbackMasked = false;
        updateFeedback();
      }
    } else {
      scheduleHide();
    }
    renderOffscreen(); // committed strokes now carry (or drop) the arrows
    redraw();
  });

  // initial sizing + re-layout on container size changes
  resize();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(container);
  } else {
    window.addEventListener("resize", resize);
  }

  return {
    /** @returns {string|null} the canonical WE2 factor (one digit per segment). */
    getSequence() {
      return !drawing && baseline === null && lastResult && lastResult.valid ? encodePattern(lastResult.segments) : null;
    },
    isVerified() {
      return verifiedCode !== null && baseline === null && lastResult &&
        lastResult.valid && verifiedCode === encodePattern(lastResult.segments);
    },
    setLocked(value) {
      locked = value;
      canvas.style.pointerEvents = value ? 'none' : '';
      updateFeedback();
    },
    /** @returns {string} status description (for error messages) */
    getStatus() {
      if (baseline !== null) return feedback.textContent;
      return lastResult ? lastResult.message : "Draw your pattern on the pad first.";
    },
    /** Clear the pad (including stamp and confirm state) */
    clear() {
      if (locked) return;
      baseline = null;
      clearBtn.click();
    },
    /** Whether a valid pattern has been recognized */
    isValid() {
      return baseline === null && !drawing && !!(lastResult && lastResult.valid);
    },
    /** Whether the pattern has been confirmed (ink erased, pad stamped) */
    isSigned() {
      return signed;
    },
  };
}

export { DIR_ARROW };
