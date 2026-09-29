// One digit per recognized segment. RU is 1; R followed by U is 02.
// Keep direction names/arrows in recognition and encode only at the KDF boundary.
import { DIRS } from './signature_recognition.js';

export function encodePattern(segments) {
  return segments.map(({ dir }) => {
    const code = DIRS.indexOf(dir);
    if (code < 0) throw new Error('Unknown pattern direction.');
    return String(code);
  }).join('');
}
