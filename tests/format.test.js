import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { displayName, parseAddresses } from '../src/lib/format.js';

const require = createRequire(import.meta.url);
const { parseAddressList } = require('../electron/db.cjs');

describe('address parsing', () => {
  const cases = [
    ['demo@emargy.test', [{ name: '', address: 'demo@emargy.test' }]],
    ['"Kareem, Sales" <k@x.test>, bob@y.test', [{ name: 'Kareem, Sales', address: 'k@x.test' }, { name: '', address: 'bob@y.test' }]],
    ['أحمد من شركة النور <ahmad@alnoor.test>; sara@p.test', [{ name: 'أحمد من شركة النور', address: 'ahmad@alnoor.test' }, { name: '', address: 'sara@p.test' }]],
  ];

  it.each(cases)('parses %s in the interface', (input, expected) => {
    expect(parseAddresses(input)).toEqual(expected);
  });

  it.each(cases)('parses %s for contact suggestions', (input, expected) => {
    expect(parseAddressList(input)).toEqual(expected.map((e) => ({ ...e, address: e.address.toLowerCase() })));
  });

  it('shows the name, or the address when there is no name', () => {
    expect(displayName('demo@emargy.test')).toBe('demo@emargy.test');
    expect(displayName('"Sara K" <sara@x.test>')).toBe('Sara K');
  });
});
