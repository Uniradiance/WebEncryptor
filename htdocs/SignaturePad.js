// SignaturePad.js — 长条形手绘图案板 (因子 C)
// 画布 → 多笔画累积 → 八方向链码识别 (signature_recognition.js) → 方向序列字符串,
// 该字符串直接作为 rulePhrase 送入 crypto_worker (worker 无需任何改动)。
//
// 交互:
//   - 多次落笔累积绘制同一图案 (每笔画完自动识别, 继续画会追加)
//   - 撤回: 撤销最后一笔
//   - 清除: 全部重画
//   - 确认: 抹去画板笔迹, 盖上"已签名"印章 (图案序列仍封存在识别器缓存, 照常供加密使用)
//   - 防偷窥: 有效时反馈栏显示方向箭头, 最后一笔之后 5 秒无新笔迹, 自动遮蔽为固定的 18 个 * 号
//   - 实时反馈: 有效 / 段数不足 / 检测到斜线, 当场可见, 不用等解密失败
// 效率: 用增量识别器 (createIncrementalRecognizer), 已落笔的笔画只提取一次
// 并缓存, 每帧只需重算"正在绘制的那一笔", 绘制中途的反馈成本与笔画总数无关。
import "./signature_recognition.js";

const REC = globalThis.SignatureRecognition;

// 最后一笔之后无新笔迹, 等待该毫秒数后把箭头内容遮蔽成 * 号
const HIDE_DELAY_MS = 5000;
// 遮蔽/已签名时显示的固定 * 号数量
const MASKED_DOTS = "*".repeat(18);

export function createSignaturePad(container, options = {}) {
  const minSegments = options.minSegments ?? 2;
  const height = options.height ?? 195; // CSS px (130 × 1.5)

  container.innerHTML = `
        <div class="sigpad">
            <div class="sigpad-stage">
                <canvas class="sigpad-canvas"></canvas>
                <div class="sigpad-stamp" hidden>已签名</div>
            </div>
            <div class="sigpad-toolbar">
                <span class="sigpad-feedback">画你的图案：每段画长一些（≥1/20 画板宽度），同一笔里越往后的转折要越长，段多就多落几笔</span>
                <span class="sigpad-actions">
                    <button type="button" class="sigpad-undo" title="撤销最后一笔">撤回</button>
                    <button type="button" class="sigpad-clear" title="全部清除重画">清除</button>
                    <button type="button" class="sigpad-confirm" title="确认签名：抹去笔迹并盖上‘已签名’章" disabled>确认</button>
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
  const ctx = canvas.getContext("2d");

  let strokes = []; // 已完成的笔画: Array<Array<{x,y}>> (与 rec 同步)
  let current = null; // 正在绘制的笔画
  let drawing = false;
  let lastResult = null;
  let rafPending = false;
  let signed = false; // 已确认: 笔迹已被抹去, 印章覆盖画板
  let feedbackMasked = false; // 箭头内容已被 * 号遮蔽
  let hideTimer = null; // 遮蔽倒计时句柄

  // 增量识别: 已完成笔画缓存提取结果, 仅当前笔画每帧重算
  const rec = REC.createIncrementalRecognizer({ minSegments });

  // --- 画布尺寸 (devicePixelRatio 感知) ---
  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  };

  const drawPolyline = (pts) => {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  };

  const redraw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (signed) return; // 已确认: 画板不留任何笔迹 (识别缓存保留, 序列照常可用)
    for (const s of strokes) drawPolyline(s);
    if (current) drawPolyline(current);
  };

  const toCssPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const updateFeedback = () => {
    const r = lastResult;
    if (signed) {
      // 已签名: 不显示说明文字, 直接呈现遮蔽为固定 18 个 * 号的状态
      feedback.textContent = MASKED_DOTS;
      feedback.className = "sigpad-feedback masked";
      feedbackMasked = false;
    } else if (!r) {
      feedback.textContent = `每段画长一些（≥1/20 画板宽度），同一笔里越往后的转折要越长，段多就多落几笔`;
      feedback.className = "sigpad-feedback";
      feedbackMasked = false;
    } else if (r.valid) {
      // 遮蔽时把箭头内容换成固定 18 个 * 号 (长度与段数无关)
      feedback.textContent = feedbackMasked ? MASKED_DOTS : r.message;
      feedback.className = feedbackMasked ? "sigpad-feedback masked" : "sigpad-feedback ok";
    } else {
      feedback.textContent = r.message;
      feedback.className = "sigpad-feedback err";
      feedbackMasked = false;
    }
    undoBtn.disabled = signed || (strokes.length === 0 && !drawing);
    clearBtn.disabled = false; // 确认后仍可清除重建 (相当于撤销确认)
    confirmBtn.disabled = !(r && r.valid && !signed);
  };

  const compute = () => {
    lastResult = rec.result(current); // 缓存的历史笔画 + 在绘笔画 (预览)
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

  // 最后一笔之后 HIDE_DELAY_MS 内无新笔迹 → 箭头自动遮蔽成 * 号
  const scheduleHide = () => {
    cancelHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (signed) return;
      feedbackMasked = true;
      updateFeedback();
    }, HIDE_DELAY_MS);
  };

  // 任何绘制活动: 取消倒计时, 立刻恢复箭头显示
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
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1) return; // 亚像素去抖
    current.push(p);
    redraw();
    scheduleCompute();
  });

  const endStroke = () => {
    if (!drawing || !current) return;
    drawing = false;
    strokes.push(current); // 累积: 不重新开始, 下一笔继续追加
    rec.addStroke(current); // 落笔: 提取结果进入缓存
    current = null;
    compute();
    scheduleHide(); // 最后一笔之后 5 秒无新笔迹 → 遮蔽箭头为 * 号
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  // 撤回最后一笔 (绘制中 / 已确认不生效)
  undoBtn.addEventListener("click", () => {
    if (drawing || signed) return;
    strokes.pop();
    rec.removeLast();
    redraw();
    compute();
    revealFeedback();
    scheduleHide(); // 撤回后若仍有效, 同样 5 秒后遮蔽
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
    redraw();
    updateFeedback();
  });

  // 确认: 抹去笔迹 → 盖上"已签名"印章 (画板像被盖住的档案; 序列仍封存可继续用)
  confirmBtn.addEventListener("click", () => {
    const r = lastResult;
    if (!r || !r.valid || signed) return;
    signed = true;
    cancelHide();
    feedbackMasked = false;
    strokes = []; // 视觉笔迹全部抹去 (rec 缓存保留, getSequence 不受影响)
    current = null;
    drawing = false;
    sigpadEl.classList.add("signed");
    redraw();
    stamp.hidden = false; // 直接显示"已签名"底板 (不做落印动画)
    updateFeedback();
  });

  // 首次尺寸 + 容器尺寸变化时重排 (容器从 display:none 变为可见时宽为 0, 需要重建)
  resize();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(container);
  } else {
    window.addEventListener("resize", resize);
  }

  return {
    /** @returns {string|null} 有效时返回方向序列 (如 "RURDLDRU"), 否则 null */
    getSequence() {
      return lastResult && lastResult.valid ? lastResult.sequence : null;
    },
    /** @returns {string|null} 状态描述 (用于错误提示) */
    getStatus() {
      return lastResult ? lastResult.message : "请先在画板上画出图案";
    },
    /** 清空画板 (含印章与确认状态) */
    clear() {
      clearBtn.click();
    },
    /** 画板是否已绘制出有效图案 */
    isValid() {
      return !!(lastResult && lastResult.valid);
    },
    /** 是否已确认签名 (笔迹已抹去并盖章) */
    isSigned() {
      return signed;
    },
  };
}
