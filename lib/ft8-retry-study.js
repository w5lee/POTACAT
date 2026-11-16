'use strict';

const PERIOD_MS = 15_000;
const NOTICE_AFTER = 3;

class Ft8RetryStudy {
  constructor(log, notify) {
    this.log = log;
    this.notify = notify;
    this.calls = new WeakMap();
    this.nextId = 0;
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

  observe(qso, { dialHz, periodStartMs, slot, results }) {
    if (!qso || !Array.isArray(results)) return;
    const call = this.calls.get(qso);
    if (!call || call.dialHz !== dialHz || call.slot === slot || call.replyPeriodMs !== periodStartMs) return;
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
      decodedSignals: results.length, replyDecoded: !!reply, replySnr: reply?.db ?? null });
    if (reply) {
      if (call.attempts > 1) this.notify(qso, `FT8 reply from ${qso.call}`, `Decoded after ${call.attempts} transmissions at ${call.offsetHz} Hz.`);
      this.calls.delete(qso);
    } else if (call.missed === NOTICE_AFTER) {
      this.notify(qso, `No FT8 reply from ${qso.call}`, `3 unanswered calls at ${call.offsetHz} Hz. Recording the baseline.`);
    }
  }
}

module.exports = { Ft8RetryStudy };
