const compact = (value) =>
  String(value)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/정상(?:범위|등급)\(([ab])\)/g, '정상($1)');
const label = {
  fastingBloodGlucose: '공복혈당',
  totalCholesterol: '총콜레스테롤',
  HDLCholesterol: 'HDL',
  LDLCholesterol: 'LDL',
  bloodPressure: '혈압',
  BMI: 'BMI',
  hemoglobin: '혈색소',
  serumCreatinine: '크레아티닌',
  AST: 'AST',
  ALT: 'ALT',
  osteoporosis: '골밀도',
};
function checkReading(text, expected) {
  const [, , value, unit] = expected;
  const line = compact(text);
  // 기대값에서 숫자를 독립적으로 읽는다. 조사 삽입과 같은 소수의 표기는 점수를 바꾸지 않는다.
  const expectedNumbers = (compact(value).match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number);
  const actualNumbers = (line.replaceAll(compact(unit), '').match(/[-+]?\d+(?:\.\d+)?/g) || []).map(
    Number,
  );
  return (
    line.includes(compact(unit)) &&
    JSON.stringify(expectedNumbers) === JSON.stringify(actualNumbers) &&
    (expectedNumbers.length > 0 || line.includes(compact(value)))
  );
}
function checkBand(text, band) {
  const line = compact(text);
  // 평가기는 기대 등급을 기준으로 원문 괄호와 부정 표현을 별도로 검사한다.
  const categories = [...line.matchAll(/(정상|질환의심|분류(?:를)?보류)(\([^)]+\))?/g)].map(
    (match) => match[0].replace('분류를보류', '분류보류'),
  );
  const expectedBand = compact(band || '분류 보류');
  return (
    categories.includes(expectedBand) &&
    categories.every(
      (category) =>
        category === expectedBand || (category === '정상' && expectedBand.startsWith('정상(')),
    ) &&
    !/(질환의심|정상\([ab]\)|분류(?:를)?보류)(?:이|가|은|는|에해당하지|에해당하지는)?(?:아니|아닌|아닙|않)/.test(
      line,
    )
  );
}
function checkText(text, expected) {
  return (
    compact(text).includes(compact(label[expected[1]])) &&
    checkReading(text, expected) &&
    checkBand(text, expected[4])
  );
}
/** 평가 정답은 사람이 읽을 수 있는 Golden Set에서 가져온다. 운영 코드의 판정 함수를 정답 생성에 쓰지 않는다. */
function rawScore(raw, expected) {
  return Object.values(firstAttemptDimensions(raw, expected)).every(Boolean);
}
/** 한 질문의 모든 근거가 일치해야 해당 차원을 통과한다. 원응답의 구조 실패도 분모에 남긴다. */
function firstAttemptDimensions(raw, expected) {
  const scores = { evidenceIds: false, valuesAndUnits: false, bands: false, textGrounding: false };
  let items;
  try {
    items = JSON.parse(raw).statements;
  } catch {
    return scores;
  }
  if (!Array.isArray(items) || items.length !== expected.length) return scores;
  const pairs = expected.map((row) => [
    row,
    items.find((item) => item?.id === row[0] + '/' + row[1]),
  ]);
  if (pairs.some(([, item]) => !item)) return scores;
  scores.evidenceIds = true;
  scores.valuesAndUnits = pairs.every(([row, item]) =>
    item.value !== undefined || item.unit !== undefined
      ? row[2] === item.value && row[3] === item.unit
      : checkReading(item.text, row),
  );
  scores.bands = pairs.every(([row, item]) =>
    item.band !== undefined ? item.band === (row[4] || '분류 보류') : checkBand(item.text, row[4]),
  );
  scores.textGrounding = pairs.every(([row, item]) => checkText(item.text, row));
  return scores;
}
function deliveredScore(body, c, httpStatus) {
  if (httpStatus !== (c.route === 'not-found' ? 404 : 200)) return false;
  if (
    c.route === 'model'
      ? !['generated', 'verified-fallback', 'model-unavailable'].includes(body.status)
      : body.status !== c.route
  )
    return false;
  const actual = body.evidence.map((e) => [e.date, e.key, e.value, e.unit, e.band]);
  if (JSON.stringify(actual) !== JSON.stringify(c.expected)) return false;
  if (!c.expected.length) return Boolean(body.answer && !/\d/.test(body.answer));
  let date = '';
  const statements = [];
  for (const line of body.answer.split('\n')) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}) 검진$/);
    if (m) date = m[1];
    else if (line.trim()) statements.push([date, line]);
  }
  return (
    statements.length === c.expected.length &&
    c.expected.every((row) => statements.some(([d, line]) => d === row[0] && checkText(line, row)))
  );
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
/** 모델을 호출하지 않은 제어 사례는 모델 정확도의 분모에서 제외한다. */
function summarize(rows) {
  const eligible = rows.filter((r) => r.route === 'model');
  const controls = rows.filter((r) => r.route !== 'model');
  return {
    requests: rows.length,
    modelRequests: eligible.length,
    deterministicControls: controls.length,
    firstPassCorrect: eligible.filter((r) => r.firstPassCorrect).length,
    firstAttemptDimensions: Object.fromEntries(
      ['evidenceIds', 'valuesAndUnits', 'bands', 'textGrounding'].map((k) => [
        k,
        eligible.filter((r) => r.dimensions[k]).length,
      ]),
    ),
    generated: eligible.filter((r) => r.response.status === 'generated').length,
    fallback: eligible.filter((r) => r.response.status === 'verified-fallback').length,
    unavailable: eligible.filter((r) => r.response.status === 'model-unavailable').length,
    finalCorrect: eligible.filter((r) => r.deliveredCorrect).length,
    controlsCorrect: controls.filter((r) => r.deliveredCorrect && !r.attempts.length).length,
    modelRouteLatencyMs: {
      p50: percentile(
        eligible.map((r) => r.elapsedMs),
        0.5,
      ),
      p95: percentile(
        eligible.map((r) => r.elapsedMs),
        0.95,
      ),
    },
    holdoutFirstPass: eligible.filter((r) => r.split === 'holdout' && r.firstPassCorrect).length,
    holdoutModelRequests: eligible.filter((r) => r.split === 'holdout').length,
    freshFirstPass: eligible.filter((r) => r.split === 'fresh' && r.firstPassCorrect).length,
    freshModelRequests: eligible.filter((r) => r.split === 'fresh').length,
  };
}
module.exports = { rawScore, firstAttemptDimensions, deliveredScore, summarize };
