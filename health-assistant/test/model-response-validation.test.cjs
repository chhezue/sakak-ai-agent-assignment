const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../dist/app');

test('인용한 행이 모두 존재하면 원문을 전달하고 잘못된 출력은 한 번의 호출로 종료한다', async () => {
  const early = '2024-07-02/공복혈당';
  const late = '2025-08-15/공복혈당';
  const raw = (sources, explanation) => JSON.stringify({ sources, explanation });
  let output,
    calls = 0;
  const app = await startApp({
    port: 0,
    log: () => {},
    model: {
      generate: async () => {
        calls++;
        return output;
      },
    },
  });
  try {
    for (const [question, draft, expected] of [
      [
        '두 검진의 혈당 차이는?',
        raw([early, late], '공복혈당은 105 mg/dL에서 95 mg/dL로 낮아졌습니다.'),
        'generated',
      ],
      ['2024-07-02 혈당은?', raw([early], '공복혈당은 105 mg/dL였습니다.'), 'generated'],
      ['2025-08-15 기록으로', raw([early], '첫 검진에서 105 mg/dL였습니다.'), 'generated'],
      [
        '이전 혈당과 최근 혈압은?',
        raw(
          [early, '2025-08-15/혈압'],
          '첫 공복혈당은 105 mg/dL이고 최근 혈압은 125/82 mmHg입니다.',
        ),
        'generated',
      ],
      ['비타민 D는?', raw([], '추정 설명'), 'unsupported'],
      ['혈당은?', '{', 'unsupported'],
      ['혈당은?', raw([early, '2025-09-03/공복혈당'], '다른 환자 기록'), 'unsupported'],
      ['혈당은?', raw([early], '  '), 'unsupported'],
      ['혈당은?', raw([early]), 'unsupported'],
      ['혈당은?', raw(early, '형식 오류'), 'unsupported'],
    ]) {
      output = draft;
      calls = 0;
      const res = await fetch((await app.getUrl()) + '/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId: 'demo-001', question }),
      });
      const body = await res.json();
      assert.equal(calls, 1);
      assert.equal(body.status, expected);
      assert.equal(body.evidence, undefined);
      assert.equal(
        body.answer,
        expected === 'generated'
          ? JSON.parse(draft).explanation
          : '해당 검진을 특정할 수 없습니다.',
      );
    }
  } finally {
    await app.close();
  }
});
