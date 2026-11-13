const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { patientEvidence } = require('../dist/health/evidence');
const { readHealthDocument } = require('../dist/health/records');
const { OllamaModel, localOllamaUrl, draftSchema } = require('../dist/assistant/model');
const { startApp } = require('../dist/app');
test('검진표상 혈압 OR와 AND, 단위 없는 검사 및 BMI 범위 경계를 해석한다', () => {
  for (const [key, value, band] of [
    ['bloodPressure', '118/92', '질환의심'],
    ['bloodPressure', '119/79', '정상(A)'],
    ['bloodPressure', '120/79', '정상(B)'],
    ['BMI', '25', '정상(B)'],
    ['BMI', '30', '질환의심'],
    ['proteinuria', '음성', '정상(A)'],
    ['osteoporosis', 'T-score -2.5', '질환의심'],
  ]) {
    const doc = structuredClone(readHealthDocument('demo-001'));
    doc.data.overviewList[1][key] = value;
    assert.equal(
      patientEvidence(doc).find((e) => e.date === '2025-08-15' && e.key === key).band,
      band,
      value,
    );
  }
});
test('Ollama HTTP 어댑터는 로컬 generate의 스키마 응답을 실제 HTTP로 읽는다', async () => {
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const data = JSON.parse(text);
    const examples = data.prompt
      .split('\n')
      .filter((line) => line.startsWith('A: '))
      .map((line) => JSON.parse(line.slice(3)));
    if (
      !data.prompt.includes('Q: 최근 건강검진 결과는 어때요?') ||
      examples.length !== 3 ||
      !examples.every((example) => draftSchema.safeParse(example).success) ||
      !examples[0].sources.includes('2025-08-15/혈압') ||
      !data.system.includes('해당 행의 검진표 판정을 그대로 전하세요.') ||
      !data.prompt.includes('Q: 콜레스테롤 수치가 어때요?') ||
      !examples[1].sources.includes('2025-08-15/LDL') ||
      !examples[2].sources.includes('2025-09-03/혈색소') ||
      !data.prompt.includes('질문: 혈압?') ||
      req.url !== '/api/generate' ||
      data.format.required.join(',') !== 'sources,explanation' ||
      !data.prompt.includes('date/검사 1') ||
      !data.format.properties.sources.items.enum.includes('date/검사') ||
      data.format.properties.sources.items.enum.includes('date/key') ||
      data.stream !== false ||
      data.options.temperature !== 0
    ) {
      res.writeHead(422).end();
      return;
    }
    res.end(
      JSON.stringify({
        done: true,
        response: '{"sources":[],"explanation":""}',
        total_duration: 9000000,
        load_duration: 1000000,
        prompt_eval_count: 12,
        prompt_eval_duration: 2000000,
        eval_count: 7,
        eval_duration: 6000000,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const metrics = [];
    const model = new OllamaModel(
      'fixture',
      'http://127.0.0.1:' + server.address().port,
      2000,
      (value) => metrics.push(value),
    );
    assert.equal(
      await model.generate({
        question: '혈압?',
        evidence: [
          {
            id: 'date/key',
            key: 'key',
            date: 'date',
            label: '검사',
            value: '1',
            unit: '',
            band: null,
          },
        ],
      }),
      '{"sources":[],"explanation":""}',
    );
    assert.deepEqual(metrics, [
      {
        totalDurationNs: 9000000,
        loadDurationNs: 1000000,
        promptEvalCount: 12,
        promptEvalDurationNs: 2000000,
        evalCount: 7,
        evalDurationNs: 6000000,
      },
    ]);
    assert.throws(() => localOllamaUrl('https://example.com'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test('기존 검진 조회는 생성이 완료되기 전에도 별도로 응답한다', async () => {
  let release, begin;
  const started = new Promise((resolve) => (begin = resolve));
  const pending = new Promise((resolve) => (release = resolve));
  const app = await startApp({
    port: 0,
    log: () => {},
    model: {
      generate: async () => {
        begin();
        await pending;
        throw new Error('끝');
      },
    },
  });
  try {
    const base = await app.getUrl();
    const generating = fetch(base + '/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId: 'demo-001', question: '최근 혈압은?' }),
    });
    await started;
    const obtained = await fetch(base + '/api/health/demo-002', {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal((await obtained.json()).data.overviewList[0].fastingBloodGlucose, '126');
    release();
    assert.equal((await (await generating).json()).status, 'model-unavailable');
  } finally {
    release();
    await app.close();
  }
});
