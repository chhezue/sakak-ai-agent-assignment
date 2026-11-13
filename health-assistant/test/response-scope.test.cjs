const { test } = require('node:test');
const assert = require('node:assert/strict');
const { patientEvidence } = require('../dist/health/evidence');
const { readHealthDocument } = require('../dist/health/records');
const { resolveDraft } = require('../dist/assistant/graph');
const { sourceId } = require('../dist/assistant/model');

test('유효한 출처의 설명은 표기나 내용에 대한 문자열 판정 없이 원문으로 전달한다', () => {
  const candidates = patientEvidence(readHealthDocument('demo-001'));
  // 출처가 유효해도 문장은 틀릴 수 있다. 계약 테스트 통과를 사실 정확성으로 오해하지 않게 한다.
  for (const [sources, explanation] of [
    [['2025-08-15/공복혈당'], '8월 15일 공복혈당은 95 mg/dL입니다.'],
    [['2025-08-15/공복혈당'], '2025-08-15 공복혈당은 95 mg/dL로 정상(A)이 아닙니다.'],
    [['2025-08-15/공복혈당'], '공복혈당은 999 mg/dL입니다.'],
    [['2025-08-15/AST', '2025-08-15/ALT'], 'AST 30 U/L / 정상(A), ALT 28 U/L / 정상(A)입니다.'],
  ]) {
    const reply = resolveDraft(JSON.stringify({ sources, explanation }), candidates);
    assert.equal(reply.status, 'generated');
    assert.equal(reply.answer, explanation);
    assert.deepEqual(reply.evidence.map(sourceId), sources);
  }
});
