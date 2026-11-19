'use strict';

// Measure the radio's incoming audio before any local waterfall gain.
function createRxLevel({ state, send, peak, getFixedGain }) {
  let measurement = null;
  let running = false;
  let peakSamples = 0;
  let peakValue = 0;
  function cancel(error) {
    if (!measurement) return;
    const m = measurement;
    measurement = null;
    clearTimeout(m.timer);
    m.resolve(error ? { error } : m);
  }
  function signature(s) {
    return [s.rxDial, s.tciMode, s.agc, s.volumeDb, s.fixedGain].join('|');
  }
  function receiving(s) {
    return s.connected && s.transmitting === false && !s.busy;
  }
  function feed(pcm) {
    const s = state();
    if (!receiving(s)) { cancel('Wait for the radio to return to receive'); return; }
    if (measurement && signature(s) !== measurement.signature) cancel('Radio settings changed. Run Auto RX Level again.');
    for (const sample of pcm) {
      const value = Math.abs(sample);
      peakValue = Math.max(peakValue, value);
      if (measurement) {
        measurement.peak = Math.max(measurement.peak, value);
        if (value >= 0.999) measurement.clipped++;
      }
    }
    peakSamples += pcm.length;
    if (peakSamples >= 3000) {
      peak({ peakDb: peakValue > 0 ? 20 * Math.log10(peakValue) : null, nearClip: peakValue >= 0.999 });
      peakSamples = peakValue = 0;
    }
    if (measurement) {
      measurement.count += pcm.length;
      if (measurement.count >= 60000) cancel();
    }
  }
  async function adjust() {
    if (running) return { error: 'RX level measurement is already running' };
    if (!receiving(state())) return { error: 'Wait for the radio to return to receive' };
    if (!Number.isFinite(state().volumeDb)) return { error: 'Waiting for the radio to report its RX volume' };
    running = true;
    const initial = state();
    const sameReceive = s => receiving(s) && s.rxDial === initial.rxDial && s.tciMode === initial.tciMode && s.agc === initial.agc;
    try {
      for (let adjustments = 0; adjustments <= 4; adjustments++) {
        const before = state();
        if (!sameReceive(before)) return { error: 'Radio settings changed. Run Auto RX Level again.' };
        const m = await new Promise(resolve => {
          measurement = { resolve, signature: signature(before), peak: 0, clipped: 0, count: 0,
            timer: setTimeout(() => cancel('No steady RX audio arrived'), 7000) };
        });
        if (m.error) return m;
        if (!(m.peak > 0.0001)) return { error: 'No usable RX audio. Try while signals are visible.' };
        const peakDb = 20 * Math.log10(m.peak);
        const correction = Math.min(12, -12 - peakDb);
        let fixedGain = null;
        if (before.agc === 'off') fixedGain = before.thetis ? before.fixedGain : await getFixedGain?.();
        if (!sameReceive(state()) || signature(state()) !== signature(before)) return { error: 'Radio settings changed. Run Auto RX Level again.' };
        const result = { peakDb, clipped: m.clipped, adjustments, volumeDb: before.volumeDb, fixedGain };
        if (Math.abs(correction) < 2) return result;
        if (adjustments === 4) return { ...result, iterationLimit: true };
        // Fixed AGC gain handles the signal level while AF trim stays at 0 dB.
        const nextGain = Number.isFinite(fixedGain) ? Math.max(-20, Math.min(80, fixedGain + 12, Math.round(fixedGain + correction + before.volumeDb))) : null;
        const gainDelta = nextGain === null ? 0 : nextGain - fixedGain;
        const nextVolume = Math.max(before.thetis ? -60 : -50, Math.min(before.thetis ? 0 : 20, before.volumeDb + correction - gainDelta));
        if (Math.abs(nextVolume - before.volumeDb) < 0.1 && gainDelta === 0) return { ...result, limited: true };
        const volumeCommand = `rx_volume:0,0,${nextVolume.toFixed(2)};`;
        const gainCommand = nextGain === null ? '' : `agc_gain:0,${nextGain};`;
        if (!send((nextVolume > before.volumeDb ? gainCommand + volumeCommand : volumeCommand + gainCommand) + 'rx_volume:0,0;' + (before.thetis ? 'agc_gain:0;' : ''))) return { error: 'TCI disconnected during adjustment' };
        // Zeus rounds AF readbacks to whole dB and reports fixed gain through
        // its engine API. Confirm the requested values on their own channels.
        let confirmed = false;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          const current = state();
          if (!sameReceive(current)) return { error: 'Radio settings changed. Run Auto RX Level again.' };
          const reportedGain = nextGain === null ? null
            : before.thetis ? current.fixedGain : await getFixedGain?.();
          if (!sameReceive(state())) return { error: 'Radio settings changed. Run Auto RX Level again.' };
          const volumeConfirmed = Math.abs(state().volumeDb - nextVolume) <= (before.thetis ? 0.1 : 0.51);
          const gainConfirmed = nextGain === null || reportedGain === nextGain;
          if (volumeConfirmed && gainConfirmed) { confirmed = true; break; }
        }
        if (!confirmed) return { error: 'The radio did not confirm the RX level adjustment' };
      }
    } catch (error) { return { error: error.message }; }
    finally { running = false; }
  }
  return { feed, adjust, cancel };
}
module.exports = { createRxLevel };
