const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDraft } = require('../dist/assistant/graph');
const { patientEvidence } = require('../dist/health/evidence');
const { readHealthDocument } = require('../dist/health/records');
const { scoreStages, summarize } = require('../evaluation/score.cjs');
const cases = [
  ...require('../evaluation/golden.json'),
  ...require('../evaluation/fresh.json'),
  ...require('../evaluation/diagnostics.json'),
];

function evaluate(id, draft) {
  const c = cases.find((entry) => entry.id === id);
  const record = readHealthDocument(c.patient);
  const candidates = record ? patientEvidence(record) : [];
  const raw = JSON.stringify(draft);
  const reply = resolveDraft(raw, candidates);
  const attempts = [{ raw, selectedIds: reply.evidence.map((row) => row.id) }];
  return { scores: scoreStages(attempts, reply, c, candidates), response: reply, attempts };
}

test('출처 선택을 비교하고 세 문장의 답변도 분량 관찰값만 남긴다', () => {
  const row = evaluate('bone-negative', {
    sources: ['2025-09-03/골밀도(T-score)'],
    explanation:
      '2025-09-03 검진 결과입니다. 골밀도 T-score는 -0.8입니다. 검진표에서 정상(A)에 해당합니다.',
  });
  assert.deepEqual(
    row.response.evidence.map((e) => e.key),
    ['osteoporosis'],
  );
  assert.equal(row.scores.disposition, 'accepted');
  assert.deepEqual(row.scores.draft, {
    selection: true,
    sentenceCount: 3,
    characterCount: row.response.answer.length,
  });
  assert.deepEqual(row.scores.final, row.scores.draft);
});

test('다른 검사일 선택은 행 ID로 검출하고 설명의 사실 점수는 만들지 않는다', () => {
  const row = evaluate('liver-pair', {
    sources: ['2024-07-02/AST', '2024-07-02/ALT'],
    explanation: '2024-07-02 검진에서 AST 30 U/L, ALT 28 U/L로 정상(A)입니다.',
  });
  assert.equal(row.scores.disposition, 'accepted');
  assert.equal(row.scores.draft.selection, false);
  assert.equal('facts' in row.scores.draft, false);
  assert.equal(row.scores.final.selection, false);
  assert.equal('facts' in row.scores.final, false);
});

test('자연어 오답을 자동 사실 점수로 바꾸지 않고 미호출·빈 선택을 별도로 집계한다', () => {
  const compare = evaluate('multiple-dates', {
    sources: ['2024-07-02/공복혈당', '2025-08-15/공복혈당'],
    explanation:
      '공복혈당은 2024-07-02에 105 mg/dL, 2025-08-15에 95 mg/dL로 20 mg/dL 감소했습니다.',
  });
  assert.equal(compare.scores.draft.selection, true);
  assert.equal('facts' in compare.scores.draft, false);
  assert.equal(compare.scores.draft.sentenceCount, 1);
  const unsupported = evaluate('unsupported', {
    sources: [],
    explanation: '비타민 D 검사 결과가 없습니다.',
  });
  const c = cases.find((entry) => entry.id === 'missing-exam');
  const response = { status: 'no-record', answer: '검진 기록이 없습니다.' };
  const noRecord = { scores: scoreStages([], response, c, []), response, attempts: [] };
  const results = summarize([compare, unsupported, noRecord]);
  assert.equal(results.dispositions['no-match'], 1);
  assert.equal(results.dispositions['not-called'], 1);
  assert.equal(results.draftRates.accepted.allRequests, 1 / 3);
  assert.equal(results.draftRates.accepted.modelCalls, 1 / 2);
  assert.deepEqual(results.final, { selection: { passed: 2, evaluated: 2 } });
  assert.equal('deliveredCorrect' in results, false);
});
