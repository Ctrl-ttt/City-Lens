import { describe, expect, it } from 'vitest';
import { isLink2 } from './Link2Controls';

describe('Link 2 browser identity', () => {
  it.each(['Insta360 Link 2', 'Insta360 Link 2 (2e1a:0001)', 'Link 2', 'INSTA360_LINK2'])('accepts %s', label => {
    expect(isLink2(label)).toBe(true);
  });

  it.each(['', 'Insta360 Link', 'Insta360 Link 2C', 'Insta360 Link 2 Pro', 'Insta360 Link 2C Pro', 'USB Camera', 'Fake Insta360 Link 2'])('rejects %s', label => {
    expect(isLink2(label)).toBe(false);
  });
});
