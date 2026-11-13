import assert from 'node:assert/strict';
import { test } from 'node:test';
import { middle, say } from './solution.js';

/** 같은 구현 오류를 공유하지 않도록 작은 항의 정답은 별도 정규표현식 생성기로 구한다. */
function oracle(seed: string, steps: number): string {
  for (let i = 0; i < steps; i += 1) {
    seed = [...seed.matchAll(/(\d)\1*/g)]
      .map(([run]) => `${run.length}${run.charAt(0)}`)
      .join('');
  }
  return seed;
}

// 묶음 개수·숫자 순서·떨어진 묶음을 구체적인 예로 나눠 검증한다.
for (const [word, expected, rule] of [
  ['1', '11', '숫자 하나도 개수 1을 먼저 쓴다'],
  ['111', '31', '인접한 같은 숫자를 묶어 개수 다음에 숫자를 쓴다'],
  ['121', '111211', '떨어져 다시 나온 같은 숫자는 앞 묶음과 합치지 않는다'],
  ['111221', '312211', '서로 다른 묶음을 원래 순서대로 이어 쓴다'],
  ['111111111111', '121', '묶음 개수가 두 자리여도 숫자로 이어 쓴다'],
] as const) {
  test(`변환 규칙: ${rule} (${word} → ${expected})`, () => {
    assert.equal(say(word), expected);
  });
}

for (const [n, expected] of [
  [4, '21'],
  [5, '12'],
  [6, '22'],
  [7, '12'],
  [8, '21'],
] as const) {
  test(`유효한 입력 n=${n}의 가운데 두 자리는 '${expected}'다`, () => {
    assert.equal(middle(n), expected);
  });
}

test('4~35의 풀이가 독립 생성기와 일치한다', () => {
  let term = '1';
  for (let n = 1; n <= 35; n += 1) {
    if (n >= 4) {
      const expected = term.slice(term.length / 2 - 1, term.length / 2 + 1);
      assert.equal(middle(n), expected, `n=${n}`);
    }
    term = oracle(term, 1);
  }
});

// 허용 범위 4~99의 바로 바깥 입력을 따로 검사해 어느 경계가 깨졌는지 구분한다.
for (const n of [3, 100]) {
  test(`n=${n}은 허용 범위 4~99 밖이므로 계산 전에 RangeError로 거부한다`, () => {
    for (const solve of [middle]) {
      assert.throws(() => solve(n), {
        name: 'RangeError',
        message: 'n must be between 4 and 99',
      });
    }
  });
}

test('경계에서 더 벗어난 0과 음수도 거부한다', () => {
  for (const solve of [middle]) {
    for (const n of [-1, 0]) assert.throws(() => solve(n), RangeError);
  }
});

test('문자열·불리언·소수·NaN·무한대는 항 번호로 받지 않는다', () => {
  for (const solve of [middle]) {
    for (const n of [true, false, '5', null, undefined, 5n, 5.5, NaN, Infinity]) {
      assert.throws(() => solve(n as number), TypeError);
    }
  }
});

test('전체 항 생성은 큰 입력에서 메모리를 소진하기 전에 구간 분할과 길이 DP를 안내한다', () => {
  assert.throws(() => middle(99), /use segment-length-dp/);
});
