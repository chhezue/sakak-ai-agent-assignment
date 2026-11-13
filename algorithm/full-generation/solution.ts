/** 정수가 아닌 입력과 범위 밖 정수를 구분해 호출자가 오류 원인을 알 수 있게 한다. */
export function validateN(n: unknown): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new TypeError('n must be an integer number');
  }
  if (n < 4 || n > 99) throw new RangeError('n must be between 4 and 99');
}

/** 인접한 묶음만 센다. 111221 → 111 | 22 | 1 → 31 | 22 | 11 → 312211. */
export function say(word: string): string {
  const parts: string[] = [];
  for (let start = 0; start < word.length;) {
    let end = start + 1;
    while (end < word.length && word.charAt(end) === word.charAt(start)) end += 1;
    // 개수는 여러 자리일 수 있다. 12개의 1은 '12' + '1' = '121'로 읽는다.
    parts.push(`${end - start}${word.charAt(start)}`);
    start = end;
  }
  return parts.join('');
}

// 검증용 기준 풀이가 입력 상한에서 메모리를 소진하지 않도록 생성량을 제한한다.
const MAX_TERM_LENGTH = 1_000_000;

/** 작은 입력을 직접 대조할 기준 풀이. n=5이면 111221을 만들고 가운데 '12'를 읽는다. */
export function middle(n: number): string {
  validateN(n);
  let term = '1';
  // 이미 첫 항이 있으므로 n번째 항까지 필요한 변환은 n-1번이다.
  for (let generation = 1; generation < n; generation += 1) {
    term = say(term);
    if (term.length > MAX_TERM_LENGTH) {
      throw new RangeError(
        'full-generation exceeds the 1,000,000-character limit; use segment-length-dp',
      );
    }
  }
  const center = term.length / 2;
  // 인덱스는 0부터 시작하고 slice의 끝은 제외된다. 길이 6이면 [2, 4)를 읽는다.
  return term.slice(center - 1, center + 1);
}
