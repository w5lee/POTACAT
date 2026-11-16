'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Ft8OffsetStudy } = require('../lib/ft8-offset-study');

function trial() {
  const log = [];
  const study = new Ft8OffsetStudy(row => log.push(row));
  const engine = {};
  study.setContext(engine, 14_074_000);
  const receive = (periodStartMs, slot, ...frequencies) =>
    study.observe({ periodStartMs, slot, results: frequencies.map(df => ({ df })) });
  const compare = (baselineAt = 30_000) =>
    study.compare({ now: 31_000, baselineAt, slot: 'even', currentHz: 1500, kind: 'cq' });
  return { log, study, engine, receive, compare };
}

test('uses both training slots and scores the two picks on a future matching receive slot', () => {
  const { log, receive, compare } = trial();
  receive(0, 'even', 1500);
  compare();
  assert.equal(log.length, 0);
  receive(15_000, 'odd', 2500);
  compare();
  assert.equal(log[0].candidateHz, 1450);
  receive(30_000, 'even', 1500); // already underway when the choice was made
  receive(45_000, 'odd', 1450); // opposite slot
  assert.equal(log.length, 1);
  receive(60_000, 'even', 1500);
  assert.equal(log[1].currentOverlap, true);
  assert.equal(log[1].candidateOverlap, false);
  assert.equal(receive(60_000, 'even'), false);
});

test('a stale baseline is skipped and a dial change drops history and pending scores', () => {
  const { log, study, engine, receive, compare } = trial();
  receive(0, 'even', 1500);
  receive(15_000, 'odd', 2500);
  compare(1000);
  assert.equal(log.length, 0);
  compare();
  study.setContext(engine, 7_074_000);
  receive(60_000, 'even', 1500);
  assert.equal(log.length, 1);
});

const { Ft8RetryStudy } = require('../lib/ft8-retry-study');
function retryTrial() {
  const log = [];
  const study = new Ft8RetryStudy(row => log.push(row), () => {});
  const qso = { mode: 'reply', phase: 'reply', myCall: 'W5LEE', call: 'K1ABC' };
  const tx = { dialHz: 7_074_000, offsetHz: 1500, slot: 'even', peakWatts: 6 };
  for (const periodStartMs of [0, 30_000, 60_000]) {
    study.transmitted(qso, { ...tx, periodStartMs });
    study.observe(qso, { ...tx, slot: 'odd', periodStartMs: periodStartMs + 15_000, results: [] });
  }
  return { log, study, qso, tx, listen: { ...tx, periodStartMs: 90_000 } };
}

test('skips one TX slot and keeps the same trial when overlap warrants a move', () => {
  const { log, study, qso, tx, listen } = retryTrial();
  assert.equal(study.defer(qso, { ...listen, hold: true }), false);
  assert.equal(study.defer(qso, listen), true);
  assert.equal(study.defer(qso, listen), true);
  let nextHz;
  study.observe(qso, { ...listen, results: [{ df: 1500 }] }, (previousHz, hz) => {
    assert.equal(previousHz, 1500);
    nextHz = hz;
    return true;
  });
  assert.equal(nextHz, 1450);
  assert.equal(study.defer(qso, { ...tx, offsetHz: nextHz, periodStartMs: 120_000 }), false);
  study.transmitted(qso, { ...tx, offsetHz: nextHz, periodStartMs: 120_000 });
  assert.equal(log.at(-1).id, log[0].id);
  assert.equal(log.at(-1).attempts, 4);
  assert.equal(log.filter(row => row.event === 'retry-listen').length, 1);
});

test('keeps the offset if the skipped slot has no decoded overlap', () => {
  const { log, study, qso, listen } = retryTrial();
  assert.equal(study.defer(qso, listen), true);
  study.observe(qso, { ...listen, results: [{ df: 1800 }] }, () => {
    assert.fail('must keep the offset');
  });
  assert.equal(log.at(-1).offsetHz, 1500);
  assert.equal(log.at(-1).moved, false);
});
