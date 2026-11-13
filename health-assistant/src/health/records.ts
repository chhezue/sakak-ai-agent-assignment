import sample from './sample.json';

export interface Measurement {
  checkupDate: string;
  [key: string]: string;
}
export interface Reference {
  refType: string;
  [key: string]: string | undefined;
}
export interface Result {
  checkupDate: string;
  organizationName: string;
  caseType: string;
  checkupType: string;
  pdfData: string;
  questionnaire: unknown[];
}
/** 과제의 공개 JSON 계약. 측정값의 문자열 타입과 키 대소문자를 보존한다. */
export interface HealthDocument {
  status: 'success';
  data: {
    patientName: string;
    overviewList: Measurement[];
    referenceList: Reference[];
    resultList: Result[];
  };
}

const base = sample.data.overviewList[0];
const metadata = sample.data.resultList[0];
// 날짜 정렬을 검증할 수 있도록 이전 기록을 먼저 둔다. 배열 순서를 최신순으로 가정하면 안 된다.
const earlier = {
  ...base,
  checkupDate: '2024-07-02',
  fastingBloodGlucose: '105',
  bloodPressure: '131/85',
  totalCholesterol: '215',
  HDLCholesterol: '51',
};
const second = {
  ...base,
  checkupDate: '2025-09-03',
  LDLCholesterol: '150',
  HDLCholesterol: '39',
  fastingBloodGlucose: '126',
  bloodPressure: '118/92',
  hemoglobin: '13.2',
  evaluation: '항목별 참고표를 확인하세요.',
};
const patients = new Map<string, { name: string; rows: Measurement[] }>([
  ['demo-001', { name: sample.data.patientName, rows: [earlier, base] }],
  ['demo-002', { name: '가상환자 이서진', rows: [second] }],
  ['demo-empty', { name: '검진 없는 가상환자', rows: [] }],
]);
/** 빈 이력과 미등록 환자는 다르다. 미등록 환자만 undefined를 반환해 404로 구분한다. */
export function readHealthDocument(id: string): HealthDocument | undefined {
  const patient = patients.get(id);
  if (!patient) return;
  return {
    status: 'success',
    data: {
      patientName: patient.name,
      overviewList: patient.rows,
      referenceList: sample.data.referenceList,
      resultList: patient.rows
        .map((row) => ({
          ...metadata,
          checkupDate: row.checkupDate,
          organizationName:
            row.checkupDate === earlier.checkupDate
              ? '가상 이전 검진기관'
              : metadata.organizationName,
        }))
        .reverse(),
    },
  };
}
