'use strict';

const PERIOD_MS = 15_000;
const MISSES_BEFORE_LISTEN = 3;
const SIGNAL_HZ = 50;

class Ft8RetryStudy {
  constructor(log, notify) {
    this.log = log;
    this.notify = notify;
    this.calls = new WeakMap();
    this.nextId = 0;
    this.nextArmByDial = new Map();
  }

  transmitted(qso, { dialHz, slot, offsetHz, periodStartMs, peakWatts }) {
    if (qso?.mode !== 'reply' || qso.phase !== 'reply' || qso.hound || qso.fd
        || !qso.call || !qso.myCall || !(peakWatts > 0)) return;
    let call = this.calls.get(qso);
    if (!call || call.dialHz !== dialHz || call.slot !== slot || call.offsetHz !== offsetHz) {
      call = { id: ++this.nextId, dialHz, slot, offsetHz, attempts: 0, missed: 0 };
      this.calls.set(qso, call);
    }
    call.attempts++;
    call.replyPeriodMs = periodStartMs + PERIOD_MS;
    this.log({ event: 'retry-transmit', ...call, peakWatts, periodStartMs });
  }

  defer(qso, { dialHz, slot, offsetHz, periodStartMs, hold }) {
    const call = qso && this.calls.get(qso);
    if (!call || qso.phase !== 'reply' || qso.hound || qso.fd
        || call.dialHz !== dialHz || call.slot !== slot || call.offsetHz !== offsetHz
        || call.listenAtMs !== periodStartMs) return false;
    if (call.listening || call.listened) return true;
    if (hold) return false;
    call.listening = true;
    this.log({ event: 'retry-listen', ...call, periodStartMs });
    this.notify(qso, 'Listening for a clear FT8 offset', `Skipping one transmission to ${qso.call} after 3 unanswered calls.`);
    return true;
  }

  observe(qso, { dialHz, periodStartMs, slot, results }, controls) {
    if (!qso || !Array.isArray(results)) return;
    const call = this.calls.get(qso);
    if (!call || call.dialHz !== dialHz || qso.phase !== 'reply') return;
    if (call.listening && call.listenAtMs === periodStartMs && call.slot === slot) {
      call.listening = false;
      call.listened = true;
      const previousHz = call.offsetHz;
      const signals = results.map(result => result?.df).filter(Number.isFinite);
      const occupied = hz => signals.some(signal => Math.abs(hz - signal) < SIGNAL_HZ);
      const overlap = occupied(previousHz);
      let bestHz = null;
      if (overlap) {
        for (let hz = 200; hz <= 2750; hz += 10) {
          const distance = Math.abs(hz - previousHz);
          if (distance < SIGNAL_HZ || occupied(hz)) continue;
          if (bestHz === null || distance < Math.abs(bestHz - previousHz)) bestHz = hz;
        }
        if (bestHz !== null && controls?.canMove(previousHz)) {
          call.arm = this.nextArmByDial.get(dialHz) || 'move';
          this.nextArmByDial.set(dialHz, call.arm === 'move' ? 'stay' : 'move');
          call.assignedAtMs = periodStartMs + PERIOD_MS;
          if (call.arm === 'move' && controls.move(bestHz)) call.offsetHz = bestHz;
        }
      }
      const moved = call.offsetHz !== previousHz;
      this.log({ event: 'retry-listen-result', ...call, periodStartMs, previousHz, overlap,
        candidateHz: bestHz, moved, decodedSignals: signals.length });
      this.notify(qso, moved ? 'FT8 retry offset changed' : 'FT8 retry offset kept',
        moved ? `Moving from ${Math.round(previousHz)} to ${call.offsetHz} Hz for the next call.`
          : call.arm === 'stay' ? `Comparison trial: retrying at ${Math.round(previousHz)} Hz despite overlap.`
            : `Next call stays at ${Math.round(previousHz)} Hz.`);
      return;
    }
    if (call.slot === slot || call.replyPeriodMs !== periodStartMs) return;
    const { replyPeriodMs, ...trial } = call;
    call.replyPeriodMs = null;
    const myCall = qso.myCall.toUpperCase();
    const theirCall = qso.call.toUpperCase();
    const reply = results.find(result => {
      const [recipient, sender] = String(result?.text || '').toUpperCase().replace(/[<>]/g, '').trim().split(/\s+/);
      return recipient === myCall && sender === theirCall;
    });
    if (!reply) call.missed++;
    this.log({ event: 'retry-receive', ...trial, missed: call.missed, periodStartMs: replyPeriodMs,
      decodedSignals: results.length, replyDecoded: !!reply, replySnr: reply?.db ?? null,
      replyDelayMs: reply && call.assignedAtMs != null ? periodStartMs - call.assignedAtMs : null });
    if (reply) {
      if (call.attempts > 1) this.notify(qso, `FT8 reply from ${qso.call}`, `Decoded after ${call.attempts} transmissions at ${call.offsetHz} Hz.`);
      this.calls.delete(qso);
    } else if (call.missed === MISSES_BEFORE_LISTEN) {
      call.listenAtMs = periodStartMs + PERIOD_MS;
    }
  }
}

module.exports = { Ft8RetryStudy };
