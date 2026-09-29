import assert from 'node:assert/strict';
import { createDirectionAssist } from '../htdocs/direction_assist.js';
import { extractStrokeSegments } from '../htdocs/signature_recognition.js';

const rotate = (p, angle) => ({
  x: p.x * Math.cos(angle) - p.y * Math.sin(angle),
  y: p.x * Math.sin(angle) + p.y * Math.cos(angle),
});
const close = (a, b, tolerance = 1e-8) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < tolerance);

for (let direction = 0; direction < 8; direction++) {
  const angle = direction * Math.PI / 4;
  const free = createDirectionAssist({ x: 0, y: 0 });
  for (let x = 1; x <= 100; x++) {
    const p = rotate({ x, y: Math.sin(x / 5) * 0.6 }, angle);
    close(free.move(p), p); // Natural small variations inside the cone survive.
  }

  const drift = createDirectionAssist({ x: 0, y: 0 });
  for (let x = 1; x <= 100; x++) {
    const p = rotate({ x, y: x * Math.tan(Math.PI / 14) }, angle);
    const assisted = rotate(drift.move(p), -angle);
    if (x <= 6) close(assisted, rotate(p, -angle));
    if (x === 100) {
      assert.ok(assisted.y < 100 * Math.tan(Math.PI / 14) - 3.9);
      assert.ok(assisted.y > 100 * Math.tan(Math.PI / 14) - 4.01);
      assert.ok(Math.abs(assisted.x - 100) < 1e-8); // Forward motion unchanged.
    }
  }
}

function driftEnd(step) {
  const assist = createDirectionAssist({ x: 0, y: 0 });
  let result;
  for (let x = step; x <= 100; x += step) result = assist.move({ x, y: x * 0.2 });
  return result;
}
close(driftEnd(1), driftEnd(10), 0.02);
close(driftEnd(0.25), driftEnd(20), 0.02);

// Strongly drifting stroke, then an intentional corner: the previous 4px
// correction releases, and the next cone is rooted at the turn, not pen-down.
{
  const assist = createDirectionAssist({ x: 0, y: 0 });
  for (let x = 1; x <= 100; x++) assist.move({ x, y: x * 0.2 });
  let result;
  for (let y = 21; y <= 100; y++) result = assist.move({ x: 100, y });
  close(result, { x: 100, y: 100 }, 0.001);
}

// Every direction can follow another in the same stroke, including reversals.
for (let first = 0; first < 8; first++) {
  for (let second = 0; second < 8; second++) {
    if (first === second) continue;
    const start = { x: 0, y: 0 };
    const assist = createDirectionAssist(start);
    const points = [start];
    const corner = rotate({ x: 80, y: 0 }, first * Math.PI / 4);
    for (let i = 1; i <= 80; i++) points.push(assist.move(rotate({ x: i, y: 0 }, first * Math.PI / 4)));
    for (let i = 1; i <= 80; i++) {
      const delta = rotate({ x: i, y: 0 }, second * Math.PI / 4);
      points.push(assist.move({ x: corner.x + delta.x, y: corner.y + delta.y }));
    }
    const result = extractStrokeSegments(points);
    assert.equal(result.count, 2, `turn ${first} -> ${second}: ${result.sequence}`);
    close(points.at(-1), {
      x: corner.x + 80 * Math.cos(second * Math.PI / 4),
      y: corner.y + 80 * Math.sin(second * Math.PI / 4),
    }, 0.001);
  }
}

// Returning inside the cone relaxes correction without a discontinuity.
{
  const assist = createDirectionAssist({ x: 0, y: 0 });
  let previous;
  for (let x = 1; x <= 100; x++) previous = assist.move({ x, y: x * 0.2 });
  for (let x = 101; x <= 180; x++) {
    const y = Math.max(0, 20 - (x - 100) * 0.3);
    const result = assist.move({ x, y });
    assert.ok(Math.hypot(result.x - previous.x, result.y - previous.y) < 2);
    previous = result;
  }
  close(previous, { x: 180, y: 0 }, 0.001);
}
console.log('direction assist: eight cones, free start, bounded pull, sampling, release and 56 turns passed');
