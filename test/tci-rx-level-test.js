'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRxLevel } = require('../lib/tci-rx-level');

function setup() {
  const state = { connected: true, transmitting: false, busy: false, rxDial: 7074000, tciMode: 'DIGU', agc: 'off', volumeDb: 0, fixedGain: 20, thetis: false };
  const sent = [], peaks = [];
  const level = createRxLevel({ state: () => ({ ...state }), send: line => {
    sent.push(line);
    for (const m of line.matchAll(/rx_volume:0,0,(-?[\d.]+);/g)) state.volumeDb = Number(m[1]);
    for (const m of line.matchAll(/agc_gain:0,(-?[\d.]+);/g)) state.fixedGain = Number(m[1]);
    return true;
  }, peak: p => peaks.push(p), getFixedGain: async () => state.fixedGain });
  return { state, sent, peaks, level };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('peak readout reports the incoming level and clipping', () => {
  const { level, peaks } = setup();
  level.feed(new Float32Array(3000).fill(0.5));
  assert.ok(Math.abs(peaks[0].peakDb + 6.0206) < 0.01);
  level.feed(new Float32Array(3000).fill(1));
  assert.equal(peaks[1].nearClip, true);
});
test('adjustment reduces hot audio, verifies it, and keeps AF trim at zero', async () => {
  const { level, state, sent } = setup();
  const pending = level.adjust();
  level.feed(new Float32Array(60000).fill(0.8));
  await wait(350);
  assert.equal(state.fixedGain, 10);
  level.feed(new Float32Array(60000).fill(0.25));
  const result = await pending;
  assert.equal(result.adjustments, 1);
  assert.ok(Math.abs(result.volumeDb) < 0.1);
  assert.ok(Math.abs(result.peakDb + 12.04) < 0.02);
  assert.ok(sent.every(line => !line.includes('trx:')));
});
test('TX, retuning, disconnect, and concurrent measurements are refused', async () => {
  const { level, state, sent } = setup();
  state.transmitting = true;
  assert.match((await level.adjust()).error, /receive/);
  state.transmitting = false;
  const pending = level.adjust();
  assert.match((await level.adjust()).error, /already/);
  state.rxDial = 14074000;
  level.feed(new Float32Array(3000));
  assert.match((await pending).error, /settings changed/);
  const disconnected = level.adjust();
  level.cancel('TCI disconnected');
  assert.match((await disconnected).error, /disconnected/);
  assert.equal(sent.length, 0);
});
test('AF volume alone adjusts when fixed gain is unavailable', async () => {
  const { level, state } = setup();
  state.agc = 'fast';
  const pending = level.adjust();
  level.feed(new Float32Array(60000).fill(0.5));
  await wait(350);
  assert.ok(state.volumeDb < -5);
  assert.equal(state.fixedGain, 20);
  level.feed(new Float32Array(60000).fill(0.25));
  assert.equal((await pending).fixedGain, null);
});
test('Zeus confirms fixed gain through its engine API with rounded AF readback', async () => {
  const s = { connected: true, transmitting: false, busy: false, rxDial: 7074000, tciMode: 'DIGU', agc: 'off', volumeDb: 0, fixedGain: null, thetis: false };
  let engineGain = 20;
  const level = createRxLevel({ state: () => ({ ...s }), peak: () => {}, getFixedGain: async () => engineGain,
    send: line => {
      const gain = line.match(/agc_gain:0,(-?[\d.]+);/);
      if (gain) engineGain = Number(gain[1]);
      const volume = line.match(/rx_volume:0,0,(-?[\d.]+);/);
      if (volume) s.volumeDb = Math.round(Number(volume[1]));
      return true;
    } });
  const pending = level.adjust();
  level.feed(new Float32Array(60000).fill(0.8));
  await wait(250);
  assert.equal(s.fixedGain, null);
  assert.ok(Math.abs(s.volumeDb) < 0.01);
  assert.equal(engineGain, 10);
  level.feed(new Float32Array(60000).fill(0.25));
  const result = await pending;
  assert.equal(result.error, undefined);
  assert.equal(result.fixedGain, 10);
});
