// Soft eight-direction guidance in CSS pixels. Direction decisions always use
// raw input; corrected ink must never reinforce its own direction lock.
const STEP = Math.PI / 4;
const HALF_ANGLE = 5 * Math.PI / 180;
const SWITCH_ANGLE = STEP / 2 + 5 * Math.PI / 180;
const nearest = angle => Math.round(angle / STEP);
const difference = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export function createDirectionAssist(start) {
  let raw = { ...start };
  let anchor = { ...start };
  let distance = 0;
  let direction = null;
  let candidate = null;
  let offset = { x: 0, y: 0 };
  const history = [{ ...start, arc: 0 }];
  let arc = 0;

  function advance(point, length) {
    arc += length;
    distance += length;
    history.push({ ...point, arc });
    // An 8px raw chord suppresses tiny tremors without hiding deliberate turns.
    while (history.length > 2 && history[1].arc <= arc - 8) history.shift();
    const tail = history[0];
    const dx = point.x - tail.x;
    const dy = point.y - tail.y;
    const angle = Math.atan2(dy, dx);
    let turning = false;
    if (direction === null) {
      if (Math.hypot(point.x - anchor.x, point.y - anchor.y) >= 6) {
        direction = nearest(Math.atan2(point.y - anchor.y, point.x - anchor.x));
      }
    } else if (Math.hypot(dx, dy) >= 4 && difference(angle, direction * STEP) > SWITCH_ANGLE) {
      turning = true;
      const next = nearest(angle);
      if (!candidate || candidate.direction !== next) {
        candidate = { direction: next, start: { ...point }, anchor: { x: tail.x, y: tail.y }, arc };
      } else if (Math.hypot(point.x - candidate.start.x, point.y - candidate.start.y) >= 6) {
        direction = next;
        anchor = candidate.anchor;
        distance = arc - candidate.arc;
        candidate = null;
        turning = false;
      }
    } else {
      candidate = null;
    }

    let targetX = 0;
    let targetY = 0;
    if (direction !== null && !turning) {
      const ux = Math.cos(direction * STEP);
      const uy = Math.sin(direction * STEP);
      const ax = point.x - anchor.x;
      const ay = point.y - anchor.y;
      const forward = ax * ux + ay * uy;
      const lateral = -ax * uy + ay * ux;
      const width = 1.5 + Math.max(0, forward) * Math.tan(HALF_ANGLE);
      const excess = Math.max(0, Math.abs(lateral) - width);
      // Smooth onset from 6 to 12px; never project onto the central ray.
      const ramp = Math.max(0, Math.min(1, (distance - 6) / 6));
      const strength = ramp * ramp * (3 - 2 * ramp);
      const correction = forward > 0 ? Math.sign(lateral) * Math.min(4, excess * 0.35) * strength : 0;
      targetX = uy * correction;
      targetY = -ux * correction;
    }
    // Distance-based relaxation: independent of pointer frequency and speed.
    // On entering the free cone or turning, the old offset fades without jumps.
    const blend = -Math.expm1(-length / 2.5);
    offset.x += (targetX - offset.x) * blend;
    offset.y += (targetY - offset.y) * blend;
  }

  return {
    move(point) {
      const dx = point.x - raw.x;
      const dy = point.y - raw.y;
      const length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length === 0) return { x: raw.x + offset.x, y: raw.y + offset.y };
      // Bound internal steps to 1px so sparse mouse events behave like dense
      // pen events, including when a turn occurs during a large displacement.
      const count = Math.ceil(length);
      for (let i = 1; i <= count; i++) {
        advance({ x: raw.x + dx * i / count, y: raw.y + dy * i / count }, length / count);
      }
      raw = { ...point };
      return { x: raw.x + offset.x, y: raw.y + offset.y };
    },
  };
}
