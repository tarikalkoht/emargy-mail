import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeSearch } = require('../electron/db.cjs');

describe('search normalization', () => {
  it('matches Arabic words however the hamza, taa marbuta or alef maqsura was written', () => {
    expect(normalizeSearch('أسامة')).toBe(normalizeSearch('اسامه'));
    expect(normalizeSearch('إيمان')).toBe(normalizeSearch('ايمان'));
    expect(normalizeSearch('آمال')).toBe(normalizeSearch('امال'));
    expect(normalizeSearch('مستشفى')).toBe(normalizeSearch('مستشفي'));
    expect(normalizeSearch('مسؤول')).toBe(normalizeSearch('مسوول'));
  });

  it('ignores diacritics, tatweel, case and extra spaces', () => {
    expect(normalizeSearch('مَشْرُوعٌ')).toBe('مشروع');
    expect(normalizeSearch('مشـــروع')).toBe('مشروع');
    expect(normalizeSearch('  Invoice   DUE ')).toBe('invoice due');
  });

  it('reads Arabic-Indic and Persian digits as 0-9', () => {
    expect(normalizeSearch('فاتورة ٢٠٢٦')).toBe(normalizeSearch('فاتوره 2026'));
    expect(normalizeSearch('۱۲۳')).toBe('123');
  });
});
