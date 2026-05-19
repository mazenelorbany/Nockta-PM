import { describe, expect, it } from 'vitest';

import { parseUserMapText } from './user-map';

describe('parseUserMapText', () => {
  it('parses a minimal CSV with header', () => {
    const m = parseUserMapText(
      [
        'accountId,email,name',
        '5f7a8b9c,alice@nockta.com,Alice Builder',
        '5d9e8a7b,bob@nockta.com,Bob',
      ].join('\n'),
    );
    expect(m.size).toBe(2);
    expect(m.get('5f7a8b9c')).toEqual({ email: 'alice@nockta.com', name: 'Alice Builder' });
    expect(m.get('5d9e8a7b')).toEqual({ email: 'bob@nockta.com', name: 'Bob' });
  });

  it('parses without a header row', () => {
    const m = parseUserMapText('5f7a8b9c,alice@nockta.com,Alice\n');
    expect(m.size).toBe(1);
    expect(m.get('5f7a8b9c')?.email).toBe('alice@nockta.com');
  });

  it('allows name to be omitted', () => {
    const m = parseUserMapText('accountId,email,name\n5f7a8b9c,bob@nockta.com');
    expect(m.get('5f7a8b9c')).toEqual({ email: 'bob@nockta.com' });
  });

  it('lowercases the email so it matches the importer', () => {
    const m = parseUserMapText('5f7a8b9c,ALICE@Nockta.COM');
    expect(m.get('5f7a8b9c')?.email).toBe('alice@nockta.com');
  });

  it('accepts TSV when the line contains tabs but no commas', () => {
    const m = parseUserMapText('5f7a8b9c\talice@nockta.com\tAlice Builder');
    expect(m.size).toBe(1);
    expect(m.get('5f7a8b9c')).toEqual({ email: 'alice@nockta.com', name: 'Alice Builder' });
  });

  it('skips blank and #-comment lines', () => {
    const m = parseUserMapText(
      [
        '# comment header',
        '',
        '5f7a8b9c,alice@nockta.com,Alice',
        '   ',
        '# another comment',
      ].join('\n'),
    );
    expect(m.size).toBe(1);
  });

  it('throws on invalid email', () => {
    expect(() => parseUserMapText('5f7a8b9c,not-an-email,Alice')).toThrow(/invalid or missing email/);
  });

  it('throws on duplicate accountId', () => {
    expect(() =>
      parseUserMapText(
        ['5f7a8b9c,alice@nockta.com,Alice', '5f7a8b9c,other@nockta.com,Other'].join('\n'),
      ),
    ).toThrow(/duplicate accountId/);
  });

  it('throws on missing accountId', () => {
    expect(() => parseUserMapText(',alice@nockta.com,Alice')).toThrow(/missing accountId/);
  });
});
