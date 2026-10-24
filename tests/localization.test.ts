/*
File purpose: Verify English-first locale behavior, subscription updates, and safe placeholder interpolation.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { locale, t, registerTranslations } from '../src/Locale';

test('Locale defaults to English and language switches interpolate data without translating it', () => {
  assert.equal(locale.language, 'en');
  assert.equal(t('Total rows: {count}', { count: 12 }), 'Total rows: 12');
  let updates = 0; const unsubscribe = locale.subscribe(() => updates++);
  try {
    locale.setLanguage('zh-CN');
    assert.equal(t('Total rows: {count}', { count: 12 }), '总行数：12');
    assert.equal(t('Filter {column}', { column: 'Save <script>$&' }), '筛选 Save <script>$&');
    assert.equal(t('Unknown CSV column'), 'Unknown CSV column');
    locale.setLanguage('zh-CN'); assert.equal(updates, 1);
    registerTranslations({ 'A {value}': '值 {value}' });
    assert.equal(t('A {value}', { value: 'x{value}$&' }), '值 x{value}$&');
    locale.setLanguage('en'); assert.equal(t('A {value}', { value: 'source' }), 'A source'); assert.equal(updates, 2);
    unsubscribe(); locale.setLanguage('zh-CN'); assert.equal(updates, 2);
  } finally { unsubscribe(); locale.setLanguage('en'); }
});
