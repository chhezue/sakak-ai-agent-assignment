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

// word: 현재 손에 있는 짧은 문자열. steps: 앞으로 더 변환할 횟수(항 번호 n과 다름).
type Piece = readonly [word: string, steps: number];
type Plan = readonly Piece[];

/**
 * 독립 조각의 확장 길이를 메모하고 목표 인덱스가 속한 조각만 탐색한다.
 * 전체 문자열을 만들지 않는 대신, 분할 전에 남은 변환의 경계 안전성을 확인한다.
 * 질의마다 인스턴스를 만들어 캐시가 다른 요청에 남지 않게 한다.
 */
export class Expansion {
  // 같은 조각이라도 남은 변환 횟수가 다르면 길이가 다르므로 둘을 묶어 키로 쓴다.
  private readonly lengths = new Map<string, bigint>();
  // 길이 계산과 문자 탐색이 같은 분할 결정을 재사용한다.
  private readonly plans = new Map<string, Plan>();
  // 같은 경계 조건을 다시 만났을 때 남은 단계의 안전성 검사를 반복하지 않는다.
  private readonly certificates = new Map<string, boolean>();
  private maxPieceLength = 0;

  // 접두부 예산이 작아 증명이 끊기면 분할을 거절한다. 정확성을 위한 가정은 아니다.
  constructor(private readonly prefixBudget = 64) {
    if (!Number.isSafeInteger(prefixBudget) || prefixBudget < 1) {
      throw new RangeError('prefixBudget must be a positive safe integer');
    }
  }

  private validateState(word: string, steps: number): void {
    if (typeof word !== 'string' || !/^\d+$/.test(word)) {
      throw new TypeError('word must be a nonempty string of digits');
    }
    if (!Number.isSafeInteger(steps) || steps < 0) {
      throw new RangeError('steps must be a nonnegative safe integer');
    }
  }

  /**
   * 왼쪽 마지막 숫자는 변환 후에도 같다. 오른쪽 첫 숫자가 남은 모든 단계에서
   * 다르면 독립적으로 변환할 수 있다. 잘린 접두부의 마지막 묶음은
   * 미완성일 수 있으므로 버린다. 다음 접두부를 모르면 안전하다고 승인하지 않는다.
   * 예: 2 | 11은 지금은 다르지만 오른쪽 11이 21이 되므로 두 번 변환할 때는 위험하다.
   * 반대로 1 | 22의 오른쪽 22는 계속 22이므로 왼쪽 마지막 1과 합쳐지지 않는다.
   */
  private independent(last: string, right: string, steps: number): boolean {
    let prefix = right.slice(0, this.prefixBudget);
    // 잘린 접두부와 전체 문자열을 구분해야 미완성 묶음을 잘못 변환하지 않는다.
    let complete = right.length <= this.prefixBudget;
    const key = `${steps}:${last}:${Number(complete)}:${prefix}`;
    const cached = this.certificates.get(key);
    if (cached !== undefined) return cached;

    let safe = true;
    for (let generation = 0; generation < steps; generation += 1) {
      if (!prefix || prefix.charAt(0) === last) {
        // 같으면 경계에서 묶음이 합쳐진다. 비어 있으면 다음 문자를 증명할 수 없다.
        safe = false;
        break;
      }
      if (generation === steps - 1) break;
      let following: string;
      if (complete) {
        following = say(prefix);
      } else {
        // '11122'까지만 보았다면 실제로는 '111222...'일 수 있다.
        // 마지막 '22'를 전부 버리고 완결된 '111'만 읽어야 정확한 다음 접두부가 된다.
        let end = prefix.length - 1;
        while (end > 0 && prefix.charAt(end - 1) === prefix.slice(-1)) end -= 1;
        following = say(prefix.slice(0, end));
      }
      // 이미 불완전한 접두부는 짧아졌더라도 전체 문자열이라고 다시 판단하지 않는다.
      complete = complete && following.length <= this.prefixBudget;
      prefix = following.slice(0, this.prefixBudget);
    }
    this.certificates.set(key, safe);
    return safe;
  }

  /** 분할은 조각 길이를, 통째 변환은 남은 횟수를 줄여 재귀가 종료되게 한다. */
  private plan(word: string, steps: number): Plan {
    const key = `${steps}:${word}`;
    const cached = this.plans.get(key);
    if (cached !== undefined) return cached;
    const cuts: number[] = [];
    for (let i = 1; i < word.length; i += 1) {
      // 같은 숫자의 묶음 한가운데는 첫 변환부터 합쳐지므로 후보에서 제외한다.
      if (word.charAt(i - 1) !== word.charAt(i)) cuts.push(i);
    }
    // 중앙에 가까운 경계를 먼저 검사해 두 자리 조회가 내려가는 깊이를 줄인다.
    cuts.sort((a, b) => Math.abs(2 * a - word.length) - Math.abs(2 * b - word.length) || a - b);
    let result: Plan | undefined;
    for (const cut of cuts) {
      if (this.independent(word.charAt(cut - 1), word.slice(cut), steps)) {
        result = [
          [word.slice(0, cut), steps],
          [word.slice(cut), steps],
        ];
        break;
      }
    }
    // 증명하지 못한 경계에서 나누는 대신 조각 전체를 정확히 변환한다.
    result ??= [[say(word), steps - 1]];
    this.plans.set(key, result);
    this.maxPieceLength = Math.max(this.maxPieceLength, word.length);
    return result;
  }

  /** 문자 내용 대신 자식 길이의 합만 구하는 동적 계획법(DP). */
  private expandedLength(word: string, steps: number): bigint {
    if (steps === 0) return BigInt(word.length);
    const key = `${steps}:${word}`;
    const cached = this.lengths.get(key);
    if (cached !== undefined) return cached;
    let size = 0n;
    for (const [part, remaining] of this.plan(word, steps)) {
      size += this.expandedLength(part, remaining);
    }
    this.lengths.set(key, size);
    return size;
  }

  /** 최종 문자열을 만들지 않고 정확한 길이를 구한다. */
  length(word: string, steps: number): bigint {
    this.validateState(word, steps);
    return this.expandedLength(word, steps);
  }

  /**
   * 목표 인덱스가 없는 조각은 길이만 빼고 건너뛴다. 인덱스는 0부터 시작한다.
   * 예: '122'를 두 번 변환하면 '21' | '22'다. 인덱스 2를 찾을 때 왼쪽 길이 2를
   * 빼면 오른쪽 '22'의 인덱스 0을 찾는 문제가 된다. 왼쪽 문자는 생성할 필요가 없다.
   */
  digit(word: string, steps: number, index: bigint): string {
    this.validateState(word, steps);
    if (typeof index !== 'bigint') throw new TypeError('index must be a bigint');
    if (index < 0n || index >= this.expandedLength(word, steps)) {
      throw new RangeError('digit index is out of range');
    }
    while (steps > 0) {
      for (const [part, remaining] of this.plan(word, steps)) {
        const size = this.expandedLength(part, remaining);
        if (index < size) {
          word = part;
          steps = remaining;
          break;
        }
        // 앞 조각의 문자를 생성하지 않고, 다음 조각의 상대 인덱스로 이동한다.
        index -= size;
      }
    }
    // 전체 길이는 bigint로 유지하고, 메모리 안의 조각 인덱스만 number로 바꾼다.
    return word.charAt(Number(index));
  }

  middle(word: string, steps: number): string {
    const size = this.length(word, steps);
    if (size < 2n || size % 2n !== 0n) {
      throw new RangeError('the expanded word must have positive even length');
    }
    // 길이 6의 가운데는 인덱스 2와 3이다. 두 문자를 왼쪽→오른쪽 순서로 반환한다.
    return this.digit(word, steps, size / 2n - 1n) + this.digit(word, steps, size / 2n);
  }

  statistics() {
    return {
      lengthStates: this.lengths.size,
      splitStates: this.plans.size,
      boundaryCertificates: this.certificates.size,
      maxPieceLength: this.maxPieceLength,
    };
  }
}

export function middle(n: number): string {
  validateN(n);
  // 첫 항 '1'에서 시작하므로 n번째 항까지 n-1번 변환한다.
  return new Expansion().middle('1', n - 1);
}

export function sequenceLength(n: number): bigint {
  validateN(n);
  return new Expansion().length('1', n - 1);
}
