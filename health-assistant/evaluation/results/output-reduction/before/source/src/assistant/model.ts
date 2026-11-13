import { z } from 'zod';
import { bands, type Evidence } from '../health/evidence';

const statementSchema = z
  .object({
    id: z.string(),
    value: z.string(),
    unit: z.string(),
    band: z.enum([...bands, '분류 보류']),
    text: z.string().min(1),
  })
  .strict();
export const draftSchema = z.object({ statements: z.array(statementSchema).min(1) }).strict();
export const outputSchema = z.toJSONSchema(draftSchema);
export const systemPrompt = [
  '당신은 합성 건강검진 기록을 한국어로 쉽게 설명합니다. 제공된 근거만 사용하세요.',
  '각 근거의 fields를 그대로 복사한 뒤 text 한 칸만 한국어로 작성하세요. 모든 근거에 하나씩 작성합니다.',
  '각 fact에는 항목명, 측정값, 단위, 검진표 분류가 들어 있습니다. fact를 빠짐없이 반영해 text에 읽기 쉬운 한 문장을 쓰세요. 원문의 분류를 한 글자도 바꾸지 마세요.',
  '완성 문장의 예: "중성지방 수치는 100 mg/dL이며, 이번 검진표의 분류는 정상(A)입니다." 예시의 이름·수치·등급은 복사하지 말고 해당 행의 fact를 사용하세요. 질환의심과 분류 보류에는 등급 문자를 붙이지 마세요.',
  '혈압 110/70처럼 슬래시가 있는 값은 한 측정값입니다. 값을 자르거나 단위를 바꾸지 마세요.',
  '날짜와 참고 기준은 화면에서 별도로 표시합니다. 문장에는 reading 이외의 숫자를 쓰지 마세요.',
  '질환의심은 검진표의 등급명입니다. 특정 질환명이나 증상, 원인, 처방을 보태지 마세요. 분류 보류 시 reason의 근거 부족을 설명하세요.',
].join('\n');
// 모델 비교에서도 동일한 옵션을 사용한다. 고정 시드는 모든 환경에서 비트 단위 재현을 보장하지 않는다.
export const generationOptions = { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 700 };
export interface GenerationInput {
  question: string;
  evidence: Evidence[];
  previousIssues: string[];
}
export interface Model {
  generate(input: GenerationInput): Promise<string>;
}
/** Ollama가 제공한 수치 메타데이터만 평가 실행기에 전달한다. 원문이나 운영 로그는 포함하지 않는다. */
export interface GenerationMetrics {
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalCount?: number;
  promptEvalDurationNs?: number;
  evalCount?: number;
  evalDurationNs?: number;
}
/** 외부 모델 주소 설정 실수로 검진 근거가 장치 밖으로 전송되는 것을 실행 시 차단한다. */
export function localOllamaUrl(
  input = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
): string {
  const u = new URL(input);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    u.protocol !== 'http:' ||
    u.username ||
    u.password
  )
    throw new Error('OLLAMA_BASE_URL은 로컬 HTTP 주소여야 합니다.');
  return u.origin;
}
export function userPrompt(input: GenerationInput): string {
  const evidence = input.evidence.map(({ id, label, value, unit, band, reason }) => ({
    fields: { id, value, unit, band: band || '분류 보류' },
    label,
    reading: [value, unit].filter(Boolean).join(' '),
    fact:
      [label, value, unit].filter(Boolean).join(' ') + ' · 검진표 분류 ' + (band || '분류 보류'),
    reason: {
      matched: '제공된 기준과 일치',
      'range-gap': '참고표에 해당 구간이 없음',
      'sex-required': '성별 정보가 없음',
      'no-reference': '항목 기준이 없음',
    }[reason],
  }));
  let prompt = JSON.stringify({ question: input.question, evidence });
  if (input.previousIssues.length)
    prompt +=
      '\n직전 출력의 다음 문제를 고쳐 전체 JSON을 다시 작성하세요. ' +
      input.previousIssues.join(', ') +
      '. fields의 네 값과 reading 전체를 그대로 사용하고, text에 등급 문구까지 정확히 포함하세요.';
  return prompt;
}
class OllamaFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** 로그에 남기는 것은 분류 코드뿐이다. 네트워크 예외나 모델의 원문은 사용자 입력을 포함할 수 있다. */
export function modelFailureCode(error: unknown): string {
  if (error instanceof OllamaFailure) return error.code;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return 'timeout';
  return 'connection-or-runtime';
}
export class OllamaModel implements Model {
  constructor(
    readonly tag: string,
    readonly origin = localOllamaUrl(),
    readonly timeoutMs = 90000,
    readonly onMetrics?: (metrics: GenerationMetrics) => void,
  ) {}
  async generate(input: GenerationInput): Promise<string> {
    const res = await fetch(this.origin + '/api/generate', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.tag,
        stream: false,
        format: outputSchema,
        system: systemPrompt,
        prompt: userPrompt(input),
        options: generationOptions,
      }),
    });
    if (!res.ok) throw new OllamaFailure('http-' + res.status);
    const data = (await res.json()) as {
      response?: string;
      done?: boolean;
      total_duration?: number;
      load_duration?: number;
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      eval_count?: number;
      eval_duration?: number;
    };
    if (!data.done || typeof data.response !== 'string')
      throw new OllamaFailure('incomplete-response');
    this.onMetrics?.({
      totalDurationNs: data.total_duration,
      loadDurationNs: data.load_duration,
      promptEvalCount: data.prompt_eval_count,
      promptEvalDurationNs: data.prompt_eval_duration,
      evalCount: data.eval_count,
      evalDurationNs: data.eval_duration,
    });
    return data.response;
  }
}
export interface Validation {
  issues: string[];
  sentences: Record<string, string>;
}
// 동치 표기만 정규화한다. '정상 범위(A)'와 '정상(A)'는 같지만 A와 B는 끝까지 구별한다.
function compact(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/정상(?:범위|등급)\(([ab])\)/g, '정상($1)');
}
/**
 * JSON 구조와 검진 사실을 별도로 검증한다. 모델의 구조화 필드가 맞더라도 한국어 문장의
 * 수치가 바뀔 수 있다. issues가 하나라도 있으면 호출자는 생성 문장 전체를 폐기한다.
 */
export function validateDraft(raw: string, evidence: Evidence[]): Validation {
  let output: unknown;
  try {
    output = JSON.parse(raw);
  } catch {
    return { issues: ['invalid-json'], sentences: {} };
  }
  const parsed = draftSchema.safeParse(output);
  if (!parsed.success) return { issues: ['invalid-schema'], sentences: {} };
  const issues = new Set<string>(),
    sentences: Record<string, string> = {};
  const expected = new Map(evidence.map((e) => [e.id, e]));
  const seen = new Set<string>();
  for (const s of parsed.data.statements) {
    const e = expected.get(s.id);
    if (!e || seen.has(s.id)) {
      issues.add('unknown-or-duplicate-evidence');
      continue;
    }
    seen.add(s.id);
    const band = e.band || '분류 보류';
    if (s.value !== e.value) issues.add('wrong-value');
    if (s.unit !== e.unit) issues.add('wrong-unit');
    if (s.band !== band) issues.add('wrong-band');
    if (!compact(s.text).includes(compact(e.label))) issues.add('missing-label');
    const prose = compact(s.text).replaceAll('분류를보류', '분류보류');
    // 조사나 1.20 같은 동치 표현은 허용한다. 숫자의 부호·값·순서와 단위는 원본과 대조한다.
    // BMI의 kg/m2처럼 단위에 속한 숫자를 먼저 제거해 측정값으로 세지 않는다.
    const unit = compact(e.unit);
    const expectedNumbers = (compact(e.value).match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number);
    const actualNumbers = (prose.replaceAll(unit, '').match(/[-+]?\d+(?:\.\d+)?/g) || []).map(
      Number,
    );
    if (
      JSON.stringify(expectedNumbers) !== JSON.stringify(actualNumbers) ||
      (!expectedNumbers.length && !prose.includes(compact(e.value)))
    )
      issues.add('ungrounded-reading');
    if (unit && !prose.includes(unit)) issues.add('missing-unit');
    if (actualNumbers.length > expectedNumbers.length) issues.add('extra-number');
    // '질환의심(A)'는 '질환의심'을 포함하지만 검진표에 없는 등급이다. 괄호까지 한 등급으로 읽는다.
    const gradeTokens = prose.match(/(?:정상|질환의심|분류보류)(?:\([^)]+\))?/g) || [];
    const allowed = compact(band);
    if (!gradeTokens.some((token) => token === allowed)) issues.add('missing-band');
    if (
      gradeTokens.some(
        (token) => token !== allowed && !(token === '정상' && allowed.startsWith('정상(')),
      )
    )
      issues.add('conflicting-band');
    if (
      /(?:정상(?:\([ab]\))?|질환의심|분류보류)(?:은|는|이|가|에해당하(?:지|지는))?(?:아니|아닙|아닌|않)/.test(
        prose,
      )
    )
      issues.add('negated-band');
    if (
      /확진|처방|당뇨|고혈압|저혈압|고지혈증|이상지질혈증|심근경색|신부전|간염|약을.{0,4}(중단|늘리|드세)|치료가 필요|정상[（(][AB][）)].{0,4}(아니|아닙)/.test(
        s.text,
      )
    )
      issues.add('unsupported-conclusion');
    sentences[e.id] = s.text.trim();
  }
  if (seen.size !== expected.size) issues.add('missing-evidence');
  return { issues: [...issues], sentences };
}
