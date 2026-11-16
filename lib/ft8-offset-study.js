'use strict';

const HISTORY_MS = 60_000;
const FOLLOW_UP_MS = 120_000;
const BASELINE_MAX_AGE_MS = 15_000;
// FT8 occupies about 50 Hz. Decoder offsets refer to the lowest tone.
const SIGNAL_HZ = 50;

function overlaps(offset, signals) {
  return signals.some(hz => Math.abs(hz - offset) < SIGNAL_HZ);
}

class Ft8OffsetStudy {
  constructor(log) {
    this.log = log;
    this.history = [];
    this.pending = [];
    this.context = null;
    this.nextId = 0;
  }

  setContext(engine, dialHz) {
    if (this.context?.engine === engine && this.context.dialHz === dialHz) return;
    this.context = { engine, dialHz };
    this.history = [];
    this.pending = [];
  }

  observe({ periodStartMs, slot, results }) {
    if (!Number.isFinite(periodStartMs) || !['even', 'odd'].includes(slot) || !Array.isArray(results)) return false;
    if (this.history.some(period => period.at >= periodStartMs)) return false;
    const signals = results.map(result => result?.df).filter(Number.isFinite);
    this.pending = this.pending.filter(pick => {
      if (periodStartMs > pick.at + FOLLOW_UP_MS) return false;
      // Score only an RX slot that began after the prediction.
      if (slot !== pick.slot || periodStartMs < pick.at) return true;
      this.log({
        event: 'score', ...pick, scoredSlotUtc: new Date(periodStartMs).toISOString(),
        currentOverlap: overlaps(pick.currentHz, signals),
        candidateOverlap: overlaps(pick.candidateHz, signals),
        decodedSignals: signals.length,
      });
      return false;
    });
    this.history = this.history.filter(period => period.at >= periodStartMs - HISTORY_MS);
    this.history.push({ at: periodStartMs, slot, signals });
    return true;
  }

  compare({ now, slot, currentHz, baselineAt, kind }) {
    if (!['even', 'odd'].includes(slot) || !Number.isFinite(currentHz)
        || now - baselineAt < 0 || now - baselineAt > BASELINE_MAX_AGE_MS) return;
    const history = this.history.filter(period => period.at >= now - HISTORY_MS && period.at + 15_000 <= now + 2000);
    const sameSlot = history.filter(period => period.slot === slot);
    if (!sameSlot.length || sameSlot.length === history.length || !history.some(period => period.signals.length)) return;

    let candidateHz = currentHz;
    let bestScore = Infinity;
    for (let hz = 200; hz <= 2750; hz += 10) {
      const all = history.filter(period => overlaps(hz, period.signals)).length;
      const same = sameSlot.filter(period => overlaps(hz, period.signals)).length;
      // Prefer avoiding stations in our intended slot. Other slots and
      // distance from the current offset break ties.
      const score = same * (history.length + 1) + all + Math.abs(hz - currentHz) / 3000;
      if (score < bestScore) {
        bestScore = score;
        candidateHz = hz;
      }
    }
    const pick = {
      id: ++this.nextId, kind, at: now, dialHz: this.context.dialHz, slot,
      currentHz, candidateHz, historyPeriods: history.length, sameSlotPeriods: sameSlot.length,
    };
    this.pending.push(pick);
    this.log({ event: 'pick', ...pick });
  }
}

module.exports = { Ft8OffsetStudy };
