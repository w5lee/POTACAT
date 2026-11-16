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
