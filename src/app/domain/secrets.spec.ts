import { describe, expect, it } from 'vitest';
import { blockedSecret, formatAllowedDomains, parseAllowedDomains } from './secrets';

describe('secret allowed domains', () => {
  it('reads domains separated by commas, spaces or lines, without duplicates', () => {
    expect(
      parseAllowedDomains(' api.example.com, *.example.org\napi.example.com  127.0.0.1 '),
    ).toEqual(['api.example.com', '*.example.org', '127.0.0.1']);
    expect(parseAllowedDomains(' , ')).toEqual([]);
    expect(formatAllowedDomains(['a.test', '*.b.test'])).toBe('a.test, *.b.test');
  });

  it('recognizes the engine error of a secret kept from a domain', () => {
    expect(blockedSecret('Secret api token cannot be sent to evil.test')).toEqual({
      name: 'api token',
      host: 'evil.test',
    });
    expect(blockedSecret('Secret not found: api')).toBeUndefined();
    expect(blockedSecret(undefined)).toBeUndefined();
  });
});
