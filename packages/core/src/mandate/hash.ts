import { canonical, sha256Hex } from './jcs.js';

export function digest(value: unknown): string {
  return 'sha256:' + sha256Hex(canonical(value));
}
