/**
 * Save a real run of the National Weather Service API to `data/snapshot/`, so
 * the dashboard can also be opened with no network.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool:
 * nothing the page loads imports it.
 *
 * The feed code the page uses is a classic script, not a module, so it cannot
 * be imported. It is run here instead, in this process, exactly as the browser
 * runs it: the file leaves its functions on `globalThis.NwsWeather` and they
 * are read from there. One copy of the feed code, used by both.
 *
 * It saves the latest observation at each curated airport, every active alert
 * currently in force, and two days of observations for each airport the
 * rolling charts follow.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const feedFile = join(here, '..', 'src', 'nws-feed.js');
runInThisContext(await readFile(feedFile, 'utf8'), { filename: feedFile });
const { fetchInitial, encodeObservation, encodeAlert, CURATED_STATIONS } = globalThis.NwsWeather;

const started = Date.now();
const { observations, alerts, series, curated } = await fetchInitial({
  onProgress: (message) => console.log(`  ${message}`),
});

const observationValues = observations.map(encodeObservation);
const alertValues = alerts.map(encodeAlert);
const seriesValues = {};
for (const id of CURATED_STATIONS) {
  seriesValues[id] = (series[id] || []).map((r) => [r.time, r.temp, r.windSpeed]);
}

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  observations: observationValues.length,
  alerts: alertValues.length,
  curated,
  source: 'National Weather Service API (api.weather.gov)',
  sourceUrl: 'https://www.weather.gov/documentation/services-web-api',
  licence: 'U.S. Government work, public domain',
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'observations.json'), JSON.stringify(observationValues));
await writeFile(join(outDir, 'alerts.json'), JSON.stringify(alertValues));
await writeFile(join(outDir, 'series.json'), JSON.stringify(seriesValues));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`\nSaved ${observationValues.length} observations and ${alertValues.length} alerts in ${seconds}s.`);
for (const id of CURATED_STATIONS) {
  console.log(`  ${id}: ${(series[id] || []).length} readings`);
}
