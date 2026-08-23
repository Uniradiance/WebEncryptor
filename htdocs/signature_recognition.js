// signature_recognition.js
// 八方向链码识别 (Freeman chain code, 8-连通): 把画板上的折线笔迹量化为
// 由 8 个方向 (横/竖/斜) 组成的方向序列, 主轴用单字母 (U/R/D/L), 对角线用双字母 (RU/RD/LD/LU)。
// 只保留"方向序列", 丢弃长度/位置/缩放信息, 因此对平移和缩放不敏感,
// 重复绘制时只需保证"拐弯数、方向、顺序"一致。
//
// 算法 v2 —— 拐角驱动:
//   1. Douglas-Peucker 去噪 (simplifyTolerance px, 自适应): 作为"非线性低通"。
//      采样步长接近抖动幅度时指针流会局部回折 (前进 2px 后退 1px ...),
//      形成 2~4px 的小环 —— 均值/中值滤波都压不干净, 但它们到弦的垂直
//      偏离极小, DP 直接把它们折叠成一条直弦, 同时保留所有真拐角
//      (偏离 ≥10px)。抖动幅度由二阶差分第 25 分位数自适应估计 (σ̂),
//      容差随 σ̂ 放大, 高抖动下不产生伪顶点。DP 输出是分段直线, 无噪声。
//   2. 重采样: 按弧长均匀采样 (resampleStep px), 统一点距, 手速无关。
//   3. 转角剖面: 对每个内部点, 用两根固定弧长的弦 (各 cornerWindow px,
//      越过该点) 测局部转向角, 再经 cornerSmooth 点滑窗压毛刺 (顶点抖动
//      对转向角有放大效应)。转向集中于短弧 (圆角半径 ≲60px) 时, 局部峰值
//      ≈ 完整转角; 大圆弧的转向摊在整条弧上, 单窗内只有 2~4° —— 因此
//      不会把"弧线"劈出伪拐角, 而集中转角的峰值与弧线相差一个数量级。
//   4. 拐角检测: 转角剖面的局部极大值 + 阈值 (minCornerTurn) +
//      邻近合并 (cornerGap px 内的候选视为同一拐角, 取更尖锐者)。
//   5. 分段: 段方向取段内点集的最小二乘主方向 (对拐角定位误差稳健,
//      短段不再被顶点偏移带偏); 段长取路径弧长 (与圆角/倒角无关)。
//   6. 修剪: 迭代删除"噪声段", 删除后重合并, 优先级 (证据由强到弱):
//      a) 桥段 —— 两侧同向的短 V 形 (抖动凸起);
//      b) 夹角段 —— 方向介于两侧、短于相对/绝对上限且一侧拐角显著
//         (≥40°): 这是圆角拐角被顶点位移劈出的"弧尾" (R→RD→D 的 RD),
//         与真实斜段 (两侧都是 ~45° 弱拐角) 的唯一定性区别;
//      c) 共线拐角 —— 两侧弦的最小二乘拟合夹角 <14°: 顶点是伪峰, 缝合;
//      d) 短段 —— 弧长 < minLegLen 或弦长 < minPointStep。
//
// 与 v1 (DP 直接定拐角 + 拐角精化, minCornerTurn=45°) 的差异:
//   - 拐角位置来自转角剖面的局部极大, 是几何确定值, 不再随噪声在
//     "整体走势 vs 单个波" 之间摇摆; 45° 浅转角、37° 斜尾均能稳定保留
//     (v1 用 45° 阈值判定拐角锐度, 恰把 45°/37° 真转角误判为弧线)。
//   - 拐角判定看"单窗转向"而非局部锐度: 大圆弧 (40°/300px) 单窗内仅
//     几度, 自然合并为单段走势; 集中转角不受影响。
//   - 短腿判定用路径弧长, 为固定绝对阈值: 抖动 V 形凸起 (≤12px) 必被删除,
//     有意图的腿 (≥26px) 必然保留, 无"逐段增长"的摆动型门槛。
//   - 复杂度 O(n log n) 均值 (v1 递归 DP 含数组切片, 最坏 O(n²), 另有
//     拐角精化的点窗口重搜索)。
//
// 双格式模块: 浏览器中以副作用 import 使用 (挂到 globalThis.SignatureRecognition),
// node 中可直接 require (module.exports)。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SignatureRecognition = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DIR_ARROW = {
    R: "→",
    L: "←",
    U: "↑",
    D: "↓",
    RU: "↗",
    RD: "↘",
    LD: "↙",
    LU: "↖",
  };

  // 八方向量化边界: 主轴扇区 ±26.6° (比值 0.5), 对角带 26.6°~63.4°。
  // 比几何等分(22.5°)略宽: 拐角顶点在抖动下会偏移数像素, 覆盖短段的弦会倾斜 10~25°,
  // 更宽的主轴扇区让这种噪声落在主轴而非误入对角带。
  const OCTANT_RATIO = 0.5;

  const DEFAULTS = {
    simplifyTolerance: 8, // px: DP 去噪容差。吸收抖动/回折环/小凸起,
    // 真拐角偏离 ≥10px 不受影响。
    resampleStep: 2, // px: 重采样步长 (统一弧长网格, 消除手速差异)
    cornerWindow: 10, // px: 转角判定的弦半长 (每侧; 总窗口 = 2×)
    cornerSmooth: 5, // 转角剖面滑窗 (重采样点数): 压掉顶点抖动的毛刺
    minCornerTurn: 24, // °: 局部转向角下限。集中转角 (圆角/倒角) 实测
    // 峰值 ≥37°−平滑衰减; 大圆弧单窗内 2~4°; 抖动毛刺经 profile 滑窗后 <8°
    cornerGap: 20, // px: 两个拐角候选的最小间距。圆角/倒角处 DP 顶点可能落在
    // 弧中点, 与真峰形成 ≤18px 的双峰 (弧尾子段会被误判成 45° 短斜段),
    // 20px 把它们并入主峰; 也决定了小于此间距的微锯齿会被合成为
    // 一个"走势段" (即被忽略)。有意图的腿长 ≥26px, 不受影响。
    minLegLen: 18, // px: 最短腿长 (路径弧长)。抖动 V 形凸起 (≤12px) 必被删除;
    // 有意图的腿缩小后仍 ≥20px, 不受影响; 圆角弧尾由夹角段规则负责删除。
    minPointStep: 2, // px: 忽略弦长小于此的退化段
    fitTurnMin: 14, // °: 拐角两侧弦的最小拟合夹角。低于此 → 两侧实质共线,
    // 顶点是抖动/弧尾伪峰, 删除并合并 (有限点拟合, 比局部转角更稳健)
    betweenMaxLen: 26, // px: "夹角段"绝对上限: 方向严格介于两侧之间、
    // 短于该长度与 betweenRatio × 两侧短者 (取大), 且一侧拐角显著
    // (below) 的段, 几乎必然是圆角弧尾 (R→RD→D 的 RD), 优先删除。
    betweenRatio: 0.65, // 弧尾长度相对两侧腿的比例上限: 弧尾随拐角产生,
    // 顶点位移可把它拉到 30px+, 与两侧腿长成比例
    betweenStrong: 40, // °: 夹角段的"强侧拐角"下限。圆角/倒角被 DP 顶点
    // 劈成"真峰 + 出口凸起"时, 中间段方向必然介于两侧 (R→RD→D),
    // 且一侧拐角是真 ~90° 峰 (实测 ≥55°); 真实斜段的两侧都是自己的
    // 弱拐角 (45° 三角实测 29~37°) —— 一侧 ≥40° 即有弧尾嫌疑。
    minSegments: 10, // 整个图案的最少段数 (熵下限)
    maxSegments: 64, // 最多段数 (防手滑乱画)
  };

  // ================= 1. 基础几何 =================

  /**
   * 位移 (dx, dy) → 八方向之一。
   * 主轴(横/竖): R/L/U/D; 对角线: RU/RD/LD/LU (首字符为水平分量, 次字符为垂直分量)。
   * 画布坐标系: y 向下为正, 所以 dy>0 是向下 (D)。
   */
  function classifyDir(dx, dy) {
    const ax = Math.abs(dx),
      ay = Math.abs(dy);
    const ratio = Math.min(ax, ay) / Math.max(ax, ay);
    if (ratio <= OCTANT_RATIO) {
      return ax >= ay ? (dx >= 0 ? "R" : "L") : dy >= 0 ? "D" : "U";
    }
    return (dx >= 0 ? "R" : "L") + (dy >= 0 ? "D" : "U");
  }

  /** 向量夹角 (0~180°); 任一为零向量时返回 0 */
  function vectorTurnDeg(ux, uy, vx, vy) {
    const cross = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy;
    if (cross === 0 && dot === 0) return 0;
    return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
  }

  /** 点到线段距离 */
  function pointLineDist(p, a, b) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(
      0,
      Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
    );
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // ================= 2. 预处理 =================

  /**
   * Douglas-Peucker 折线简化 (迭代版, 无数组切片, 均值 O(n log n))。
   * 在本管线中作为非线性低通: 折叠抖动/回折环, 保留真拐角。
   * @returns 保留点在 points 中的下标 (严格递增, 含首尾)
   */
  function simplifyPolylineIdx(points, epsilon) {
    const n = points.length;
    const keep = new Uint8Array(n);
    if (n <= 2) return points.map((_, i) => i);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0,
        maxI = -1;
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

  /** Douglas-Peucker 折线简化 (返回点, 兼容旧接口) */
  function simplifyPolyline(points, epsilon) {
    return simplifyPolylineIdx(points, epsilon).map((i) => points[i]);
  }

  /** 沿折线按弧长均匀重采样 (保留首尾点)。O(n) */
  function resamplePolyline(points, step) {
    const s = step > 0 ? step : 2;
    if (!points || points.length < 2) {
      return points ? points.map((p) => ({ x: p.x, y: p.y })) : [];
    }
    const out = [{ x: points[0].x, y: points[0].y }];
    let walked = 0; // 自上一个输出点起已走的弧长
    for (let i = 1; i < points.length; i++) {
      const ax = points[i - 1].x,
        ay = points[i - 1].y;
      const bx = points[i].x,
        by = points[i].y;
      const dx = bx - ax,
        dy = by - ay;
      const segLen = Math.hypot(dx, dy);
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

  /**
   * 滑动平均平滑 (O(n) 前缀和)。首尾点窗口收缩, 不引入边界偏移。
   * 保留供外部兼容使用; v2 管线本身不需要 (DP 去噪后路径已是分段直线)。
   */
  function smoothPoints(points, window) {
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

  // ================= 3. 拐角检测 =================

  /** 估计笔迹抖动幅度 σ̂ (px): 二阶差分绝对值的第 25 分位数。
   *  回折环/拐角/高抖动区会污染上分位数 (中位数在 σ≈1.5 时偏高 50%),
   *  而第 25 分位数始终落在"基线直线段"上, 实测与真 σ 的比值稳定 ≈0.925。
   *  用于自适应 DP 容差。 */
  function estimateJitterSigma(points) {
    const n = points.length;
    if (n < 8) return 0;
    const diffs = new Float64Array(n - 2);
    for (let i = 1; i < n - 1; i++) {
      diffs[i - 1] =
        Math.hypot(
          points[i - 1].x - 2 * points[i].x + points[i + 1].x,
          points[i - 1].y - 2 * points[i].y + points[i + 1].y,
        ) / 2;
    }
    diffs.sort();
    return diffs[Math.floor(diffs.length * 0.25)] / 0.925;
  }

  /** 累计路径弧长 (用于 O(1) 取任意段弧长) */
  function cumulativeArcLengths(pts) {
    const n = pts.length;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] =
        cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return cum;
  }

  /**
   * 拐角检测: 转角剖面的局部极大值。
   * DP 去噪后的分段直线上, 每个内部点的局部转向角 = 该点两侧各
   * cornerWindow px 的弦之间的夹角 (0~180°)。真拐角的转向集中在短弧内 →
   * 剖面呈峰; 大圆弧的转向均摊在长弧上 → 单窗内仅几度; 抖动毛刺经
   * cornerSmooth 滑窗后远低于阈值。取峰顶为拐角位置 (几何确定, 不随噪声
   * 跳动), 峰值低于 minCornerTurn 的候选视为弧线/抖动, 忽略; 间距小于
   * cornerGap 的候选合并为同一拐角 (取更尖锐者)。
   * @returns {{corners:number[], turn:Float64Array}} 拐角下标 (含首尾) 与剖面
   */
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
    // 剖面滑窗去噪: 顶点抖动对转向角有放大效应 (中点误差 ×2),
    // 5 点滑窗压到 ~√5 分之一; 真峰宽 ≥10 采样点, 衰减 <10%。
    const H = Math.max(1, ((o.cornerSmooth | 0) - 1) >> 1); // ±H 点
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
      // 局部极大 (平顶取左端; 峰位偏差 ≤1 采样点 ≈2px, 可忽略)
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

  // ================= 4. 分段与修剪 =================

  /** 八方向中心角 (索引): 用于"夹角段"判定 */
  const DIR_INDEX = { R: 0, RU: 1, U: 2, LU: 3, L: 4, LD: 5, D: 6, RD: 7 };

  /** 段方向是否严格位于两侧方向之间 (八方向环上的短弧) */
  function isBetweenMid(dir, a, b) {
    if (a === b) return false;
    const f = (x, y) => (DIR_INDEX[y] - DIR_INDEX[x] + 8) % 8;
    const arc = f(a, b);
    if (arc <= 4) return f(a, dir) > 0 && f(a, dir) < arc; // 前向短弧
    const back = 8 - arc; // 后向短弧
    return f(dir, a) > 0 && f(dir, a) < back;
  }

  /**
   * 点集主方向的拟合 (最小二乘): 返回单位向量 (dx, dy), 方向取 [i0+i1] 弦向。
   * 点数不足时返回 null。
   */
  function fitDirection(pts, i0, i1, margin) {
    const lo = i0 + margin,
      hi = i1 - margin;
    const cnt = hi - lo + 1;
    if (cnt < 4) return null;
    let sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0;
    for (let i = lo; i <= hi; i++) {
      const x = pts[i].x,
        y = pts[i].y;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    const mx = sx / cnt,
      my = sy / cnt;
    const vxx = sxx - cnt * mx * mx,
      vyy = syy - cnt * my * my,
      vxy = sxy - cnt * mx * my;
    const ang = 0.5 * Math.atan2(2 * vxy, vxx - vyy); // 主轴方向
    let dx = Math.cos(ang),
      dy = Math.sin(ang);
    // 消方向歧义: 一律顺着段的首尾走向
    const fx = pts[hi].x - pts[lo].x,
      fy = pts[hi].y - pts[lo].y;
    if (dx * fx + dy * fy < 0) {
      dx = -dx;
      dy = -dy;
    }
    return { dx, dy };
  }

  /** 相邻拐角之间的"段": dir 来自段内点集的最小二乘拟合方向 (对拐角
   * 定位误差稳健, 短段/长段一致; 点数不足时退回净位移弦向); arc 来自
   * 路径弧长 (与圆角/倒角无关); tin/tout 为两端拐角的剖面转角。 */
  function buildSegments(pts, cum, corners, turn, o) {
    const segs = [];
    for (let j = 1; j < corners.length; j++) {
      const i0 = corners[j - 1],
        i1 = corners[j];
      if (i1 <= i0) continue;
      const dx = pts[i1].x - pts[i0].x,
        dy = pts[i1].y - pts[i0].y;
      const chord = Math.hypot(dx, dy);
      if (chord < o.minPointStep) continue; // 退化段: 直接跳过
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

  /** 合并相邻同向段 (删除噪声顶点后两侧回到同一方向时) */
  function mergeSameDir(list) {
    if (list.length < 2) return list;
    const out = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const s = list[i],
        last = out[out.length - 1];
      if (last.dir === s.dir) {
        last.dx += s.dx;
        last.dy += s.dy;
        last.chord = Math.hypot(last.dx, last.dy);
        last.arc += s.arc;
        last.i1 = s.i1;
      } else {
        out.push(s);
      }
    }
    return out;
  }

  /** 删除两段之间的拐角 (跨过该角缝合两段, 方向用净位移重算) */
  function stitch(a, b) {
    const dx = a.dx + b.dx,
      dy = a.dy + b.dy;
    return {
      i0: a.i0,
      i1: b.i1,
      dx,
      dy,
      chord: Math.hypot(dx, dy),
      arc: a.arc + b.arc,
      dir: classifyDir(dx, dy),
      tin: a.tin,
      tout: b.tout,
    };
  }

  /**
   * 迭代式修剪: 每轮删除一条"最可能是噪声"的段, 删除后重新合并, 直到
   * 无可删。候选优先级 (几何证据由强到弱):
   *   1. 桥段: 两侧同向的短 V 形 (抖动凸起);
   *   2. 夹角段: 方向严格介于两侧之间 + 小于 betweenMaxLen + 一侧拐角
   *      转角 < betweenFlankMax (圆角弧尾: 两侧拐角远强于弧尾的
   *      "出口凸起"; 有意图的斜段两侧都是强拐角, 不受影响);
   *   3. 共线拐角: 两侧弦的拟合夹角 < fitTurnMin (顶点是伪峰, 缝合两侧);
   *   4. 短段: 弧长 < minLegLen 或弦长 < minPointStep。
   * 每次至多删除 k 条, k ≤ maxSegments, 代价可忽略。
   */
  function pruneSegments(list, pts, o) {
    let cur = mergeSameDir(list);
    for (;;) {
      let bridge = -1,
        between = -1,
        collinear = -1,
        firstShort = -1;
      for (let i = 0; i < cur.length; i++) {
        const s = cur[i];
        const short = s.chord < o.minPointStep || s.arc < o.minLegLen;
        if (short && firstShort === -1) firstShort = i;
        const p = cur[i - 1],
          n = cur[i + 1];
        if (p && n) {
          if (short && bridge === -1 && p.dir === n.dir) bridge = i;
          if (
            between === -1 &&
            isBetweenMid(s.dir, p.dir, n.dir) &&
            s.arc < Math.max(o.betweenMaxLen, o.betweenRatio * Math.min(p.arc, n.arc)) &&
            Math.max(s.tin ? s.tin : 0, s.tout ? s.tout : 0) >= o.betweenStrong
          ) {
            between = i;
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
      else if (collinear !== -1) {
        // 删除伪峰: 缝合两侧段
        const stitched = stitch(cur[collinear - 1], cur[collinear]);
        cur.splice(collinear - 1, 2, stitched);
      } else if (firstShort !== -1) cur.splice(firstShort, 1);
      else break;
      cur = mergeSameDir(cur);
    }
    return cur;
  }

  // ================= 5. 笔画级识别 =================

  const EMPTY = { sequence: "", segments: [], count: 0, empty: true };

  /**
   * 单笔画 → 段序列 (不做段数门槛, 不处理多笔画)。
   * 管线: DP 去噪 → 重采样 → 转角剖面局部极大 (拐角) → 分段 → 修剪。
   * @returns {{sequence:string, segments:Array, count:number, empty:boolean}}
   */
  function extractStrokeSegments(rawPoints, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!rawPoints || rawPoints.length < 2) return EMPTY;
    const step = Math.min(Math.max(0.5, o.resampleStep), 8);
    // 自适应 DP 容差: 抖动越大, 回折环/毛刺的偏差越大, 容差随估计的
    // 抖动幅度放大 (下限为基础值, 上限 clamp 防误吞真拐角)。
    const sigma = estimateJitterSigma(rawPoints);
    const tol = Math.min(Math.max(o.simplifyTolerance, sigma * 5), o.simplifyTolerance * 1.6);
    // DP 去噪 (折叠回折环/抖动) → 弧长均匀重采样 → 转角剖面
    const idxs = simplifyPolylineIdx(rawPoints, tol);
    const pts = resamplePolyline(idxs.map((i) => rawPoints[i]), step);
    if (pts.length < 2) return EMPTY;

    const { corners, turn } = detectCorners(pts, o);
    const segs = buildSegments(pts, cumulativeArcLengths(pts), corners, turn, o);
    if (segs.length === 0) return EMPTY;

    const kept = pruneSegments(segs, pts, o);
    if (kept.length === 0) return EMPTY;

    return {
      sequence: kept.map((s) => s.dir).join(""),
      segments: kept.map((s) => ({ dir: s.dir, length: Math.round(s.arc) })),
      count: kept.length,
      empty: false,
    };
  }

  // ================= 6. 图案级识别 =================

  /** 汇总各笔画结果 → 最终判定 (供 recognizeStrokes 与增量识别器共用) */
  function finalizeParts(parts, o) {
    const fail = (invalidReason, message, count) => ({
      valid: false,
      sequence: null,
      segments: [],
      count: count || 0,
      invalidReason,
      message,
    });

    let sequence = "",
      segments = [],
      count = 0;
    for (const p of parts) {
      sequence += p.sequence;
      segments = segments.concat(p.segments);
      count += p.count;
    }

    if (count === 0) return fail("empty", "请先在画板上画出图案");
    if (count < o.minSegments) {
      return fail(
        "too_few_segments",
        `段数不足: ${count}/${o.minSegments}`,
        count,
      );
    }
    if (count > o.maxSegments) {
      return fail(
        "too_many_segments",
        `图案过于复杂（${count} 段），请简化到 ${o.maxSegments} 段以内`,
        count,
      );
    }

    return {
      valid: true,
      sequence,
      segments,
      count,
      invalidReason: null,
      message: `有效: ${segments.map((s) => DIR_ARROW[s.dir]).join("")} 共 ${count} 段`,
    };
  }

  /**
   * 多笔画识别: 每笔画独立处理, 按绘制顺序拼接方向序列。
   * 逐笔画归一化(每笔按自身笔迹长度算阈值), 笔画间抬笔跳越不会产生幻影段。
   * @param {Array<Array<{x:number,y:number}>>} strokes 笔画数组 (每个元素是一串点)
   * @param {object} [opts] 覆盖 DEFAULTS
   * @returns {{valid:boolean, sequence:string|null, segments:Array, count:number,
   *            invalidReason:string|null, message:string}}
   */
  function recognizeStrokes(strokes, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!strokes || strokes.length === 0) {
      return {
        valid: false,
        sequence: null,
        segments: [],
        count: 0,
        invalidReason: "empty",
        message: "请先在画板上画出图案",
      };
    }
    const parts = [];
    for (const raw of strokes) parts.push(extractStrokeSegments(raw, o));
    return finalizeParts(parts, o);
  }

  /** 单笔画识别 (兼容旧接口) */
  function recognizeSequence(rawPoints, opts) {
    return recognizeStrokes([rawPoints], opts);
  }

  // ================= 7. 增量识别 (执行流程优化) =================

  /**
   * 增量识别器: 已落笔的笔画只提取一次并缓存, 每次调用只重算"正在绘制的
   * 那一笔"。绘制大图案时每帧成本从 O(总点数) 降到 O(当前笔点数)。
   * result(partial) 的 partial 是尚未落笔的当前笔画点集 (可 null), 只作为
   * "预览"参与判定, 不缓存。
   */
  function createIncrementalRecognizer(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const parts = [];
    return {
      /** 落笔: 提交一笔已完成笔画 */
      addStroke(rawPoints) {
        parts.push(extractStrokeSegments(rawPoints, o));
      },
      /** 撤回最后一笔 */
      removeLast() {
        parts.pop();
      },
      /** 清空全部 */
      clear() {
        parts.length = 0;
      },
      /** 当前识别结果: 已完成笔画 + 可选的在绘笔画 (预览) */
      result(partialPoints) {
        if (partialPoints && partialPoints.length) {
          return finalizeParts(
            parts.concat([extractStrokeSegments(partialPoints, o)]),
            o,
          );
        }
        return finalizeParts(parts, o);
      },
      /** 已完成笔画数 */
      get strokeCount() {
        return parts.length;
      },
    };
  }

  return {
    recognizeStrokes,
    recognizeSequence,
    extractStrokeSegments,
    createIncrementalRecognizer,
    classifyDir,
    simplifyPolyline,
    smoothPoints,
    resamplePolyline,
    DIR_ARROW,
    DEFAULTS,
  };
});
