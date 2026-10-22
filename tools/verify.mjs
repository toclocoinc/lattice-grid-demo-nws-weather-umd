/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the National Weather Service API being reachable. It does depend on
 * the Lattice Grid CDN, because that is where the page gets the grid from.
 *
 * It asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag (no type="module", pinned
 *     release, no integrity hashes, each file left its global);
 *   - the observations table holds rows, the alerts table holds rows, and the
 *     eight rolling charts drew marks;
 *   - the headline figures agree with the saved data, recomputed here;
 *   - a pushed alert lands in the alerts table, and never in the observations
 *     table;
 *   - the temperature heat scale is held as runtime formatting state.
 *
 * It then blocks the API in the browser and opens the live page, to prove a
 * visitor gets the saved copy, and is told so, when the NWS cannot be reached.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

const GRID_VERSION = '1.111.7';
const CDN_BASE = `https://cdn.latticegrid.dev/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

/** The order the snapshot stores an observation row in, for recomputation. */
const OBSERVATION_COLUMNS = ['id', 'station', 'name', 'city', 'temp', 'windSpeed', 'windDirection', 'humidity', 'pressure', 'text', 'time'];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`);
  }
}

function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'nws-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__nwsWeather)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__nwsWeather.ready, error: window.__nwsWeather.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__nwsWeather.observationsGrid && window.__nwsWeather.observationsGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy.                                                  */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    const globals = {};
    for (const name of ['LatticeGrid', 'LatticeGridDataRouter', 'LatticeGridKPI', 'LatticeGridTabs']) {
      const value = window[name];
      globals[name] = value ? Object.keys(value).filter((k) => typeof value[k] === 'function').length : 0;
    }
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.latticegrid\\.dev/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.latticegrid\\.dev/.test(s.src) && (s.integrity || s.crossOrigin)).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.latticegrid.dev"]') || {}).href || null,
      globals,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        createHeadlessGrid: typeof (window.LatticeGrid || {}).createHeadlessGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity attribute; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(delivery.librarySrcs.length === LIBRARY_TAGS.length, `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`, `${delivery.librarySrcs.length}`);
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.some((src) => src.split('?')[0] === wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === 0, 'delivery: no library tag carries an integrity or crossorigin attribute', `${delivery.withIntegrity}`);
  check((delivery.stylesheetSrc || '').split('?')[0] === `${CDN_BASE}lattice-grid.min.css`, `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`, delivery.stylesheetSrc);
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');
  check(delivery.members.createHeadlessGrid === 'function', 'delivery: createHeadlessGrid is on the core global');

  const snap = await evaluate(`(() => {
    const d = window.__nwsWeather;
    return {
      obsRows: d.observationsGrid.rows.count(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      watermark: d.observationsGrid.licence.watermark(),
      licenceState: d.observationsGrid.licence.state(),
      stations: d.kpi.value('stations'),
      avgTemp: d.kpi.value('avgTemp'),
      alerts: d.alertsKpi.value('alerts'),
      severe: d.alertsKpi.value('severe'),
      heatRules: d.observationsGrid.formatting.list('temp').length,
      warm: document.querySelector('.kpi-named-value').textContent,
      freshness: document.querySelector('.freshness').textContent,
    };
  })()`);
  console.log(`  ${snap.obsRows} observations, ${snap.painted} painted, ${snap.charts} charts`);
  console.log(`  stations ${snap.stations}, avgTemp ${snap.avgTemp}, alerts ${snap.alerts}, severe ${snap.severe}`);

  check(snap.obsRows > 0, 'saved copy: the observations table holds rows', `${snap.obsRows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 8, 'saved copy: all eight rolling charts were built', `${snap.charts}`);
  check(snap.heatRules > 0, 'saved copy: the temperature heat scale is runtime formatting state', `${snap.heatRules} rules`);

  const drawn = await evaluate(`(() => window.__nwsWeather.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('path, circle').length : 0;
    return { i, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points`);
    check(c.marks > 0, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  noErrors('saved copy');
  await shoot('01-observations');

  /* Independent recomputation from the saved data. */
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const observationValues = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'observations.json'), 'utf8'));
  const alertValues = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'alerts.json'), 'utf8'));
  const observationRows = observationValues.map((v) => {
    const row = {};
    OBSERVATION_COLUMNS.forEach((col, index) => { row[col] = v[index]; });
    return row;
  });

  const temps = observationRows.filter((r) => typeof r.temp === 'number').map((r) => r.temp);
  const expected = {
    stations: observationRows.length,
    alerts: alertValues.length,
    maxTemp: Math.max(...temps),
    minTemp: Math.min(...temps),
    avgTemp: temps.reduce((a, b) => a + b, 0) / temps.length,
  };

  check(snap.stations === expected.stations, 'saved copy: the station count matches the saved data', `tile ${snap.stations}, expected ${expected.stations}`);
  check(snap.alerts === expected.alerts, 'saved copy: the active-alert count matches the saved data', `tile ${snap.alerts}, expected ${expected.alerts}`);
  check(Math.abs(Number(snap.avgTemp) - expected.avgTemp) < 0.05, 'saved copy: the average temperature matches the saved data', `tile ${snap.avgTemp}, expected ${expected.avgTemp.toFixed(1)}`);
  check(snap.warm.includes(expected.maxTemp.toFixed(1)), 'saved copy: the warmest station is named with its temperature', snap.warm);
  check(snap.warm !== 'No data', 'saved copy: the warmest station is not the empty state', snap.warm);

  /* ---- the alerts table is a separate dataset ---- */

  await evaluate("window.__nwsWeather.tabs.activate('alerts')");
  await waitFor('!!window.__nwsWeather.alertsGrid', 30000, 'the alerts table');
  await waitFor('window.__nwsWeather.alertsGrid.rows.count() > 0', 30000, 'the alerts table rows');
  const alertsCount = await evaluate('window.__nwsWeather.alertsGrid.rows.count()');
  check(alertsCount === expected.alerts, 'the alerts table holds the saved alerts', `${alertsCount}`);

  /* A pushed alert lands in the alerts table, not the observations table. */
  const injected = await evaluate(`(async () => {
    const d = window.__nwsWeather;
    const obsBefore = d.observationsGrid.rows.count();
    const alertsBefore = d.alertsGrid.rows.count();
    d.ingest([{ kind: 'alert', id: 'verify-alert', event: 'Test Flood Warning', type: 'Warning', severity: 'Severe', headline: 'Test headline', description: '', areaDesc: 'Test Area', effective: Date.now(), expires: Date.now() + 3600000, sent: Date.now(), count: 1 }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.alertsGrid.rows.forEach((r) => { if (r && r.data && r.data.id === 'verify-alert') found = r.data; });
    let leaked = false;
    d.observationsGrid.rows.forEach((r) => { if (r && r.data && r.data.id === 'verify-alert') leaked = true; });
    return { alerts: d.alertsGrid.rows.count(), obs: d.observationsGrid.rows.count(), alertsBefore, obsBefore, severity: found ? found.severity : null, type: found ? found.type : null, leaked };
  })()`);
  console.log(`  injected alert: alerts ${injected.alertsBefore} -> ${injected.alerts}, observations ${injected.obsBefore} -> ${injected.obs}`);
  check(injected.alerts === injected.alertsBefore + 1, 'a pushed alert lands in the alerts table', `${injected.alerts}`);
  check(injected.obs === injected.obsBefore, 'the alert did not leak into the observations table', `${injected.obs}`);
  check(injected.leaked === false, 'the alert is absent from the observations table', injected.leaked);
  check(injected.severity === 'Severe', 'the alert carries its severity', injected.severity);
  check(injected.type === 'Warning', 'the alert carries its classified type', injected.type);
  await shoot('02-alert-injected');
  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. What a visitor gets when the NWS API cannot be reached.          */
  /* =================================================================== */

  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*api.weather.gov*'] });
  await open(`${origin}/index.html`, 'live page, with the API unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__nwsWeather;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    const freshness = document.querySelector('.freshness');
    return {
      rows: d.observationsGrid.rows.totalCount(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  rows ${fallback.rows}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.rows > 0, 'fallback: the saved copy is on screen', `${fallback.rows} rows`);
  check(fallback.painted > 0, 'fallback: the table painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(!!fallback.notice && /could not be reached/i.test(fallback.notice), 'fallback: the page says the API was unreachable', fallback.notice);
  check(!fallback.polling, 'fallback: no poll is started against an API that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('03-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    await open(`${origin}/index.html`, 'live');
    const live = await evaluate(`(() => {
      const d = window.__nwsWeather;
      return {
        rows: d.observationsGrid.rows.count(),
        charts: d.charts.length,
        fellBack: !!(d.timings && d.timings.fellBack),
        watermark: d.observationsGrid.licence.watermark(),
        freshness: document.querySelector('.freshness').textContent,
        stations: d.kpi.value('stations'),
        alerts: d.alertsKpi.value('alerts'),
      };
    })()`);
    console.log(`  ${live.rows} observations from the live API; ${live.freshness}`);
    check(live.fellBack === false, 'live: the rows came from the API, not the saved copy');
    check(live.rows > 0, 'live: the table holds rows from the API', `${live.rows}`);
    check(live.charts === 8, 'live: all eight rolling charts were built', `${live.charts}`);
    check(live.watermark === false, 'live: no watermark on localhost');
    check(typeof live.stations === 'number' && live.stations > 0, 'live: the tiles read the API', `${live.stations} stations`);
    check(typeof live.alerts === 'number' && live.alerts >= 0, 'live: the alert tiles read the API', `${live.alerts} alerts`);
    noErrors('live');
    await shoot('04-live');

    const failed = await evaluate(`(() => {
      const d = window.__nwsWeather;
      const before = d.observationsGrid.rows.count();
      d.onPollError(new Error('a deliberate failure, for the check'));
      return { before, after: d.observationsGrid.rows.count(), text: document.querySelector('.freshness').textContent, className: document.querySelector('.freshness').className };
    })()`);
    check(failed.after === failed.before, 'live: a failed poll does not lose the table', `${failed.before} -> ${failed.after}`);
    check(/could not reach/i.test(failed.text), 'live: a failed poll is said out loud', failed.text);
    check(/failed/.test(failed.className), 'live: a failed poll is marked visually', failed.className);
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
