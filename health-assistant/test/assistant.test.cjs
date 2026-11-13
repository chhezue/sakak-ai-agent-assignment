const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../dist/app.js');

async function withApp(model, run, log = () => {}) {
  const app = await startApp({ port: 0, model, log });
  try {
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}
async function ask(url, question, patientId = 'demo-001') {
  const res = await fetch(url + '/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId, question }),
  });
  return { status: res.status, body: await res.json() };
}
const workingModel = {
  generate: async () =>
    JSON.stringify({
      sources: ['2025-08-15/공복혈당'],
      explanation: '2025-08-15 검진에서 공복혈당은 95 mg/dL로 정상(A)입니다.',
    }),
};
test('건강검진 GET은 안내문의 키와 문자열 측정값, 단위 행을 보존한다', async () => {
  await withApp(workingModel, async (url) => {
    const body = await (await fetch(url + '/api/health/demo-001')).json();
    assert.equal(body.status, 'success');
    const checkup = body.data.overviewList.find((r) => r.checkupDate === '2025-08-15');
    assert.equal(checkup.BMI, '23.5');
    assert.equal(checkup.bloodPressure, '125/82');
    assert.equal(body.data.referenceList.find((r) => r.refType === '단위').HDLCholesterol, 'mg/dL');
    assert.equal(
      body.data.resultList.find((r) => r.checkupDate === checkup.checkupDate).organizationName,
      '서울병원',
    );
    assert.equal((await fetch(url + '/api/health/absent')).status, 404);
  });
});
test('첫 검진 요청에서 모델은 두 날짜의 후보를 받고 첫 검진의 수치가 답변에 직접 포함된다', async () => {
  const model = {
    generate: async ({ question, evidence }) => {
      assert.equal(question, '맨 처음 받았을 때 혈당은?');
      assert.ok(evidence.some((e) => e.id === '2025-08-15/fastingBloodGlucose'));
      assert.ok(evidence.some((e) => e.id === '2024-07-02/totalCholesterol'));
      return JSON.stringify({
        sources: ['2024-07-02/공복혈당'],
        explanation: '2024-07-02 첫 검진에서 공복혈당은 105 mg/dL였습니다.',
      });
    },
  };
  await withApp(model, async (url) => {
    const { body } = await ask(url, '맨 처음 받았을 때 혈당은?');
    assert.equal(body.status, 'generated');
    assert.match(body.answer, /2024-07-02.*공복혈당.*105 mg\/dL/);
    assert.doesNotMatch(body.answer, /95 mg\/dL/);
    assert.equal(body.evidence, undefined);
  });
});
test('웹에서 선택할 수 있는 검진 기록이 공개 API의 세 사례와 일치한다', async () => {
  await withApp(workingModel, async (url) => {
    const html = await (await fetch(url + '/')).text();
    const select = html.match(/<select id="patient">([\s\S]*?)<\/select>/)[1];
    assert.doesNotMatch(html, /<table|검진 근거|실행 정보/);
    const ids = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    const counts = { 'demo-001': 2, 'demo-002': 1, 'demo-empty': 0 };
    assert.deepEqual(ids, Object.keys(counts));
    for (const id of ids) {
      const response = await fetch(url + '/api/health/' + id);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.overviewList.length, counts[id]);
    }
  });
});
test('모델 장애에서 수치를 추측하지 않고 기록 없음과 잘못된 요청을 구별한다', async () => {
  await withApp(
    {
      generate: async () => {
        throw new Error('offline');
      },
    },
    async (url) => {
      const result = await ask(url, '최근 혈압은?');
      assert.equal(result.body.status, 'model-unavailable');
      assert.match(result.body.answer, /연결하지 못해/);
      assert.equal((await ask(url, '최근 혈압은?', 'absent')).status, 404);
      assert.equal((await ask(url, '최근 혈압은?', 'demo-empty')).body.status, 'no-record');
      assert.equal((await ask(url, '   ')).status, 400);
    },
  );
});
test('요청별 로그는 결과와 같은 추적 ID를 사용하고 질문·환자·검진값을 기록하지 않는다', async () => {
  const events = [];
  await withApp(
    workingModel,
    async (url) => {
      const q = '최근 공복혈당 확인 부탁해요';
      const { body } = await ask(url, q);
      const trace = events.filter((e) => e.requestId === body.requestId);
      assert.ok(trace.some((e) => e.stage === 'complete' && e.outcome === 'generated'));
      assert.ok(trace.every((e) => e.durationMs >= 0));
      for (const event of trace) {
        for (const key of Object.keys(event))
          assert.ok(
            ['requestId', 'stage', 'outcome', 'durationMs', 'count', 'attempt', 'issues'].includes(
              key,
            ),
            key,
          );
      }
      assert.doesNotMatch(JSON.stringify(trace), /홍길동|demo-001|공복혈당|mg\/dL/);
    },
    (event) => events.push(event),
  );
});
