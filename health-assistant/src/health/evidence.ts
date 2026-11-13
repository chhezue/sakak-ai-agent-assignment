import type { HealthDocument, Measurement, Reference } from './records';

const metrics = [
  ['height', '신장'],
  ['weight', '체중'],
  ['waists', '허리둘레'],
  ['BMI', 'BMI'],
  ['vision', '시력'],
  ['hearing', '청력'],
  ['bloodPressure', '혈압'],
  ['proteinuria', '요단백'],
  ['hemoglobin', '혈색소'],
  ['fastingBloodGlucose', '공복혈당'],
  ['totalCholesterol', '총콜레스테롤'],
  ['HDLCholesterol', 'HDL'],
  ['triglyceride', '중성지방'],
  ['LDLCholesterol', 'LDL'],
  ['serumCreatinine', '크레아티닌'],
  ['GFR', 'GFR'],
  ['AST', 'AST'],
  ['ALT', 'ALT'],
  ['yGPT', '감마지티피'],
  ['chestXrayResult', '흉부촬영'],
  ['osteoporosis', '골밀도'],
] as const;
type Metric = (typeof metrics)[number];
export const bands = ['정상(A)', '정상(B)', '질환의심'] as const;
export type Band = (typeof bands)[number];
export interface Evidence {
  id: string;
  key: string;
  label: string;
  date: string;
  organization?: string;
  value: string;
  unit: string;
  band: Band | null;
  reference: string;
  reason: 'matched' | 'range-gap' | 'sex-required' | 'no-reference';
}

/** 제공 표의 범위 표기만 해석한다. 알 수 없는 표기를 임의의 정상 범위로 채우지 않는다. */
function matchesNumber(raw: string, value: number): boolean {
  const condition = raw.trim();
  const range = condition.match(/^(-?\d+(?:\.\d+)?)\s*[-~]\s*(-?\d+(?:\.\d+)?)$/);
  if (range) return value >= Number(range[1]) && value <= Number(range[2]);
  const limit = condition.match(/^(-?\d+(?:\.\d+)?)\s*(미만|이하|초과|이상)$/);
  if (!limit) return false;
  const n = Number(limit[1]);
  switch (limit[2]) {
    case '미만':
      return value < n;
    case '이하':
      return value <= n;
    case '초과':
      return value > n;
    default:
      return value >= n;
  }
}
function matchesCell(key: string, raw: string, value: string): boolean {
  if (key === 'bloodPressure') {
    const [sys, dia] = value.split('/').map(Number);
    const [a, b] = raw.replace(/이며|또는/g, '').split('/');
    if (!a || !b || !Number.isFinite(sys) || !Number.isFinite(dia)) return false;
    const systolic = matchesNumber(a, sys),
      diastolic = matchesNumber(b, dia);
    return raw.includes('또는') ? systolic || diastolic : systolic && diastolic;
  }
  if (key === 'osteoporosis') {
    const n = Number(value.replace(/^T-score\s*/i, ''));
    const descending = raw.match(/^(-?[\d.]+)~(-?[\d.]+)\s*초과$/);
    return descending
      ? n < Number(descending[1]) && n > Number(descending[2])
      : matchesNumber(raw.replace(/^T-score\s*/i, ''), n);
  }
  if (value === raw) return true;
  if (!value.trim() || !Number.isFinite(Number(value))) return false;
  return raw.split('/').some((condition) => matchesNumber(condition, Number(value)));
}
function evidenceFor(metric: Metric, record: Measurement, refs: Reference[]): Evidence | undefined {
  const [key, label] = metric;
  const value = record[key];
  if (!value?.trim()) return;
  const reference = (type: string) => refs.find((row) => row.refType === type)?.[key]?.trim() || '';
  const entry: Evidence = {
    id: record.checkupDate + '/' + key,
    date: record.checkupDate,
    key,
    label,
    value,
    unit: reference('단위'),
    band: null,
    reference: '',
    reason: 'no-reference',
  };
  const criteria = bands.map((band) => ({ band, cell: reference(band) })).filter((r) => r.cell);
  if (!criteria.length) return entry;
  // 성별이 없으면 성별 기준을 적용할 수 없다. 이름·측정값으로 성별을 추측하지 않는다.
  if (criteria.some((row) => /남\s*[:\d]|여\s*[:\d]/.test(row.cell)))
    return { ...entry, reason: 'sex-required' };
  // 혈압 118/92처럼 조건이 겹치면 질환의심을 정상보다 먼저 확인한다.
  const match = criteria.reverse().find((row) => matchesCell(key, row.cell, value));
  return match
    ? { ...entry, band: match.band, reference: match.cell, reason: 'matched' }
    : { ...entry, reason: 'range-gap' };
}

/** 질문별로 미리 거르지 않고 전체 검진을 최신순으로 연결해 모델이 시점·항목을 고르게 한다. */
export function patientEvidence(doc: HealthDocument): Evidence[] {
  const reports = [...doc.data.overviewList].sort((a, b) =>
    b.checkupDate.localeCompare(a.checkupDate),
  );
  return reports.flatMap((row) => {
    const organization = doc.data.resultList.find(
      (result) => result.checkupDate === row.checkupDate,
    )?.organizationName;
    return metrics.flatMap((metric) => {
      const item = evidenceFor(metric, row, doc.data.referenceList);
      return item ? [{ ...item, organization }] : [];
    });
  });
}
