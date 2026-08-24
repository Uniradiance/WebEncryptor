// SignaturePad.js — elongated hand-drawn pattern pad (factor C).
//
// Canvas -> multi-stroke accumulation -> 8-direction chain code recognition
// (recognition_engine.js, Rust/WASM accelerated with a parity JS fallback) ->
// direction-sequence string, fed to the crypto worker as rulePhrase.
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
            <div class="sigpad-stage">
                <canvas class="sigpad-canvas"></canvas>
                <div class="sigpad-stamp" hidden>SIGNED</div>
            </div>
            <div class="sigpad-toolbar">
                <span class="sigpad-feedback">Draw your pattern on the pad.</span>
                <span class="sigpad-actions">
                    <button type="button" class="toggle-rule-button sigpad-directions-toggle" id="toggleRuleEncrypt" title="Always show stroke directions" aria-label="Always show stroke directions" aria-pressed="false">
                        <svg class="eye-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button>
                    <button type="button" class="sigpad-undo" title="Undo the last stroke" aria-label="Undo the last stroke">
                        <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 0 24 24" width="20px" fill="currentColor" aria-hidden="true">
                            <path d="M0 0h24v24H0V0z" fill="none"></path>
                            <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"></path>
                        </svg>
                    </button>
                    <button type="button" class="sigpad-clear" title="Clear everything and redraw" aria-label="Clear everything and redraw">
                        <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 0 24 24" width="20px" fill="currentColor" aria-hidden="true">
                            <path d="M0 0h24v24H0V0z" fill="none"></path>
                            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"></path>
                        </svg>
                    </button>
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

  // Offscreen canvas holding the committed strokes (redraw cache)
  const offscreen = document.createElement("canvas");
  const offCtx = offscreen.getContext("2d");

  // Incremental recognizer: committed strokes cached, only the current stroke
  // is recomputed per frame.
  const rec = createIncrementalRecognizer({ minSegments });

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

  const drawPolyline = (c, pts) => {
    if (!pts || pts.length < 2) return;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.strokeStyle = "#1f2937";
    c.lineWidth = 3;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.stroke();
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
    for (const s of strokes) {
      drawPolyline(offCtx, s);
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
      if (current) drawPolyline(ctx, current);
      if (showDirections && current) drawDirectionArrows(ctx, current);
    }
  };

  const toCssPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const updateFeedback = () => {
    const r = lastResult;
    if (signed) {
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
    undoBtn.disabled = signed || (strokes.length === 0 && !drawing);
    clearBtn.disabled = false; // clear works even after confirm (equivalent to undoing it)
    confirmBtn.disabled = !(r && r.valid && !signed);
  };

  const compute = () => {
    lastResult = rec.result(current);
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

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (drawing || signed) return;
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
    strokes.push(current); // accumulate: the next stroke appends to the pattern
    rec.addStroke(current); // commit: result enters the cache
    current = null;
    const last = strokes[strokes.length - 1];
    drawPolyline(offCtx, last); // update the redraw cache once
    if (showDirections) drawDirectionArrows(offCtx, last);
    compute();
    scheduleHide();
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  undoBtn.addEventListener("click", () => {
    if (drawing || signed) return;
    strokes.pop();
    rec.removeLast();
    renderOffscreen();
    redraw();
    compute();
    revealFeedback();
    scheduleHide();
  });

  clearBtn.addEventListener("click", () => {
    strokes = [];
    current = null;
    drawing = false;
    lastResult = null;
    signed = false;
    feedbackMasked = false;
    cancelHide();
    sigpadEl.classList.remove("signed");
    stamp.hidden = true;
    rec.clear();
    renderOffscreen();
    redraw();
    updateFeedback();
  });

  // Confirm: erase the ink, stamp the pad (the sequence stays cached for use)
  confirmBtn.addEventListener("click", () => {
    const r = lastResult;
    if (!r || !r.valid || signed) return;
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
    /** @returns {string|null} the direction sequence (e.g. "RURDLDRU") when valid */
    getSequence() {
      return lastResult && lastResult.valid ? lastResult.sequence : null;
    },
    /** @returns {string} status description (for error messages) */
    getStatus() {
      return lastResult ? lastResult.message : "Draw your pattern on the pad first.";
    },
    /** Clear the pad (including stamp and confirm state) */
    clear() {
      clearBtn.click();
    },
    /** Whether a valid pattern has been recognized */
    isValid() {
      return !!(lastResult && lastResult.valid);
    },
    /** Whether the pattern has been confirmed (ink erased, pad stamped) */
    isSigned() {
      return signed;
    },
  };
}

export { DIR_ARROW };
