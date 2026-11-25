// Key admission (src/key-admission.ts): the corpus of our own texts is up to date, and a key that is short or shares
// a piece with any of our texts is refused with a text that holds no piece of it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXED_CORPUS } from '../src/fixed-corpus.generated.js';
import { fixedOutputs } from '../src/fallbacks.js';
import { admitsKey, KEY_REFUSED, keyRefusedText, MIN_KEY_LENGTH, visibleTexts } from '../src/key-admission.js';
import { gateway } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

describe('key admission', () => {
  it('has a corpus that lists every string literal in src/', () => {
    // Exits 1, and so throws, when a text was added or changed without regenerating the corpus.
    execFileSync(process.execPath, ['scripts/fixed-corpus.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
    expect(FIXED_CORPUS.length).toBeGreaterThan(20);
  });

  it('accepts a vendor-like key and refuses short keys and keys that share text with our own texts', () => {
    expect(admitsKey('notreal-qqqq-wwww-zzzz-qqqq-wwww')).toBe(true);
    expect(admitsKey('notreal-qqqq-ww'.slice(0, MIN_KEY_LENGTH - 1))).toBe(false);
    const colliding = [
      '‹redacted›-notreal-qqqq',
      '[nested too deep]notreal-',
      KEY_REFUSED,
      ...FIXED_CORPUS.filter(text => text.length >= 6).slice(0, 50).map(text => `notreal-qqqq${text}`),
    ];
    for (const key of colliding) expect(admitsKey(key), key).toBe(false);
  });

  it('never repeats a piece of a refused key in the refusal', () => {
    for (const key of [KEY_REFUSED, `xx${KEY_REFUSED.slice(4, 40)}yy`, '‹redacted›-notreal-qqqq', 'short-key']) {
      const text = keyRefusedText(key);
      for (const piece of pieces(key)) expect(text, `${key} / ${piece}`).not.toContain(piece);
    }
  });

  // A key is refused when it shares any 6 characters with a text of ours. Real keys are GUIDs (client id), 32 hex
  // digits (subscription key) and base64 (client secret). A random key in base64 meets an ordinary word of ours only
  // by a vanishing chance, but a GUID or hex key is drawn from 0-9, a-f and '-' alone, so any run of 6 or more of
  // those characters in our texts (a phone number, a date, an id, a regex range, a word like "bedded") is a piece a
  // real key can hold, and such a key would be refused for no reason. The rule: no text a key is compared against
  // (the corpus, the refusal, the fallbacks and the tool list) holds a run of 6 or more characters from
  // [0-9A-Fa-f-]. That covers runs of 6 or more digits too, which is checked on its own as well for clarity.
  const HEX_RUN = /[0-9A-Fa-f-]{6,}/g;
  const DIGIT_RUN = /[0-9]{6,}/g;

  it('has no text a key is compared against that holds a run a GUID, hex or digit key can share', () => {
    const { gw } = gateway();
    const compared = [...FIXED_CORPUS, KEY_REFUSED, ...visibleTexts(fixedOutputs()), ...visibleTexts(gw.tools)];
    const runs = compared.flatMap(text => [...(text.match(HEX_RUN) ?? []), ...(text.match(DIGIT_RUN) ?? [])].map(run => `${run} in ${text.slice(0, 80)}`));
    expect(runs).toEqual([]);
  });

  it('admits realistic made-up keys whose hex or digit runs once matched an example in our texts', () => {
    // Made up, and written in parts around the run that matters so a secret scanner does not take them for real.
    const keys = {
      clientId: ['e89f2345-c841-4bc7-a695-', '234567', 'ab89cd'].join(''), // GUID
      subscriptionKey: ['7c3e9a1f0b', '123456', 'd8e2f4a6c9b0e1d3'].join(''), // 32 hex digits
      clientSecret: ['xK9vB2mN7pQ4', '345678', 'wR1tY6uI0oP3aS5dF8gH+/='].join(''), // base64
    };
    for (const key of Object.values(keys)) expect(admitsKey(key), key).toBe(true);
    // The whole gateway takes them too: the fallbacks and the tool list hold no piece of them.
    expect(() => gateway({}, keys)).not.toThrow();
  });
});
