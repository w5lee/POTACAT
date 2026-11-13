'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function zeusLogPath() {
  const home = os.homedir();
  let dataDir = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  if (process.platform === 'win32') dataDir = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (process.platform === 'darwin') dataDir = path.join(home, 'Library', 'Application Support');
  return path.join(dataDir, 'Zeus', 'logs', 'zeus-app.log');
}

async function recentZeusPorts() {
  let log;
  try {
    log = await fs.open(zeusLogPath(), 'r');
    const { size } = await log.stat();
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await log.read(buffer, 0, buffer.length, size - buffer.length);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const matches = text.matchAll(/Diagnostics Request (?:starting|finished) HTTP\/1\.1 GET http:\/\/(?:127\.0\.0\.1|localhost|x\.x\.x\.x):(\d{1,5})\/api\/(?:display\/bandwidth-spectrum|rx\/adc-protection|state)\b/g);
    return [...new Set([...matches].reverse().map(match => Number(match[1])))].filter(port => port > 0 && port <= 65535);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  } finally {
    await log?.close();
  }
}

async function readZeusEngineState(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
    signal: AbortSignal.timeout(1500), redirect: 'error',
  });
  if (!response.ok) throw new Error('Could not read the Zeus engine');
  const state = await response.json();
  if (typeof state.agc?.mode !== 'string' || typeof state.autoAgcEnabled !== 'boolean' ||
      typeof state.status !== 'string') throw new Error('The port did not report Zeus engine state');
  return { port, state };
}

async function findZeusEngineState(overridePort) {
  if (overridePort) return readZeusEngineState(overridePort);
  for (const port of (await recentZeusPorts()).slice(0, 3)) {
    try {
      return await readZeusEngineState(port);
    } catch {
      // A Zeus restart can leave an old port in the log.
    }
  }
  return null;
}

const ZEUS_NR_MODES = ['Off', 'Anr', 'Emnr', 'Rnnr', 'Sbnr', 'Nnr'];

async function cycleZeusEngineNr(engine, canChange) {
  const current = engine.state.receivers?.[0]?.nrMode ?? engine.state.nr?.nrMode;
  const available = ZEUS_NR_MODES.filter(mode => mode !== 'Rnnr' || engine.state.wdspNr3RnnrAvailable !== false);
  const next = available[(available.indexOf(current) + 1) % available.length];
  if (!canChange()) return null;
  const response = await fetch(`http://127.0.0.1:${engine.port}/api/receivers/0`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nrMode: next }), signal: AbortSignal.timeout(1500), redirect: 'error',
  });
  if (!response.ok) throw new Error('Zeus rejected the NR mode change');
  const state = await response.json();
  const confirmed = state.receivers?.[0]?.nrMode ?? state.nr?.nrMode;
  if (confirmed !== next) throw new Error('Zeus did not confirm the NR mode change');
  return ZEUS_NR_MODES.indexOf(confirmed);
}

module.exports = { findZeusEngineState, cycleZeusEngineNr };
