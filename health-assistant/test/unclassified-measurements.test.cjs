const { test } = require('node:test');
const assert = require('node:assert/strict');
const { patientEvidence } = require('../dist/health/evidence');
const { readHealthDocument } = require('../dist/health/records');
test('표의 공백과 환자 정보 부족은 원본 수치와 분류 보류 사유로 남는다', () => {
  const rows = patientEvidence(readHealthDocument('demo-002'));
  for (const [key, value, reason] of [
    ['LDLCholesterol', '150', 'range-gap'],
    ['hemoglobin', '13.2', 'sex-required'],
  ]) {
    const row = rows.find((e) => e.key === key);
    assert.deepEqual([row.value, row.band, row.reason], [value, null, reason]);
  }
});
