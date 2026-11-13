import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Expansion, middle, say, sequenceLength } from './solution.js';

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
  // 독립 생성기로 구한 50항은 894,810자, 51항은 1,166,642자다. 여기서 전체 항 생성 한도를 넘는다.
  [50, '21'],
  [51, '13'],
] as const) {
  test(`n=${n}의 가운데 두 자리는 '${expected}'다`, () => {
    assert.equal(middle(n), expected);
  });
}

test('4~35의 풀이와 전체 길이가 독립 생성기와 일치한다', () => {
  let term = '1';
  for (let n = 1; n <= 35; n += 1) {
    if (n >= 4) {
      const expected = term.slice(term.length / 2 - 1, term.length / 2 + 1);
      assert.equal(middle(n), expected, `segment-length-dp: ${n}`);
      assert.equal(sequenceLength(n), BigInt(term.length), `length: ${n}`);
    }
    term = oracle(term, 1);
  }
});

// 허용 범위 4~99의 바로 바깥 입력을 따로 검사해 어느 경계가 깨졌는지 구분한다.
for (const n of [3, 100]) {
  test(`n=${n}은 허용 범위 4~99 밖이므로 계산 전에 RangeError로 거부한다`, () => {
    for (const solve of [middle, sequenceLength]) {
      assert.throws(() => solve(n), {
        name: 'RangeError',
        message: 'n must be between 4 and 99',
      });
    }
  });
}

test('경계에서 더 벗어난 0과 음수도 거부한다', () => {
  for (const solve of [middle, sequenceLength]) {
    for (const n of [-1, 0]) assert.throws(() => solve(n), RangeError);
  }
});

test('문자열·불리언·소수·NaN·무한대는 항 번호로 받지 않는다', () => {
  for (const solve of [middle, sequenceLength]) {
    for (const n of [true, false, '5', null, undefined, 5n, 5.5, NaN, Infinity]) {
      assert.throws(() => solve(n as number), TypeError);
    }
  }
});

test('지금 다른 숫자라도 다음 단계에 합쳐질 경계는 독립적으로 나누지 않는다', () => {
  // 211 → 1221 → 112211. 잘못 나눈 2 | 11을 각각 두 번 변환하면 1112 | 1211이 된다.
  const engine = new Expansion();
  const expected = '112211';
  assert.equal(engine.length('211', 2), 6n);
  assert.equal(
    Array.from({ length: expected.length }, (_, i) => engine.digit('211', 2, BigInt(i))).join(
      '',
    ),
    expected,
  );
});

test('안전한 두 조각의 경계를 조회할 때 왼쪽 길이만큼 인덱스를 뺀다', () => {
  // 122 → 1122 → 21 | 22. 왼쪽 끝 인덱스 1과 오른쪽 첫 인덱스 2는 각각 1과 2다.
  const engine = new Expansion();
  assert.equal(engine.length('122', 2), 4n);
  assert.equal(engine.digit('122', 2, 1n), '1');
  assert.equal(engine.digit('122', 2, 2n), '2');
  assert.equal(engine.middle('122', 2), '12');
});

test('같은 숫자의 긴 묶음과 떨어져 다시 등장한 숫자의 모든 자리를 검증한다', () => {
  let state = 20261111;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const seeds = ['1', '11', '111', '22', '1211', '111221', '312211', '1'.repeat(12)];
  for (let i = 0; i < 30; i += 1) {
    const size = (next() % 19) + 1;
    seeds.push(Array.from({ length: size }, () => String((next() % 3) + 1)).join(''));
  }
  for (const seed of seeds) {
    for (const steps of [0, 1, 3, 7]) {
      const expected = oracle(seed, steps);
      const engine = new Expansion();
      assert.equal(engine.length(seed, steps), BigInt(expected.length));
      const actual = Array.from({ length: expected.length }, (_, i) =>
        engine.digit(seed, steps, BigInt(i)),
      ).join('');
      assert.equal(actual, expected, `${seed}, steps=${steps}`);
    }
  }
});

test('접두부가 잘려 다음 경계를 알 수 없으면 보수적으로 전체 조각을 변환한다', () => {
  for (const budget of [1, 2, 4, 16]) {
    const engine = new Expansion(budget);
    for (const seed of ['111222', '12111222', '3112112', '222111222']) {
      const expected = oracle(seed, 6);
      assert.equal(engine.length(seed, 6), BigInt(expected.length));
      assert.equal(
        Array.from({ length: expected.length }, (_, i) =>
          engine.digit(seed, 6, BigInt(i)),
        ).join(''),
        expected,
      );
    }
  }
});

test('빈 시작값·잘못된 단계·인덱스와 홀수 길이의 가운데 조회를 거부한다', () => {
  const engine = new Expansion();
  for (const budget of [0, -1, 1.5, Infinity]) {
    assert.throws(() => new Expansion(budget), RangeError);
  }
  assert.throws(() => engine.length('', 0), TypeError);
  assert.throws(() => engine.length('abc', 0), TypeError);
  for (const steps of [-1, 0.5, Infinity]) {
    assert.throws(() => engine.length('1', steps), RangeError);
  }
  for (const index of [-1n, 1n]) {
    assert.throws(() => engine.digit('1', 0, index), RangeError);
  }
  assert.throws(() => engine.digit('1', 0, 0 as unknown as bigint), TypeError);
  assert.throws(() => engine.middle('1', 0), RangeError);
});

test('최댓값 99의 길이와 앞·중간·뒤 문자가 서로 다른 접두부 예산에서 일치한다', () => {
  const first = new Expansion(32);
  const second = new Expansion(64);
  const size = first.length('1', 98);
  assert.equal(size, 392187941864n);
  assert.equal(second.length('1', 98), size);
  for (const index of [0n, 1n, size / 2n - 1n, size / 2n, size - 2n, size - 1n]) {
    assert.equal(first.digit('1', 98, index), second.digit('1', 98, index));
  }
  assert.equal(first.middle('1', 98), '11');
  assert.equal(middle(99), '11');
  assert.equal(sequenceLength(99), size);
});
