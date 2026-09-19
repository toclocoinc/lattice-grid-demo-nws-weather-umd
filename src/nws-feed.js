/**
 * The National Weather Service feeds: the latest observation at a curated set
 * of major US airports, a rolling window of observations for each of them, and
 * every active weather alert currently in force across the country.
 *
 * Nothing here knows about the grid. It produces plain objects and hands them
 * to whoever asked, so the same code feeds the live page and the saved copy.
 *
 * The API is public and needs no key, and it answers with open cross-origin
 * headers, so the browser reads it directly. Observations are published every
 * few minutes from each airport's automated station; alerts are raised and
 * lowered by the National Weather Service as conditions change.
 *
 * The service asks callers to send a descriptive User-Agent. A browser sends
 * its own and the API works regardless; the snapshot tool runs this same file
 * under Node, where no browser header exists, so a User-Agent is set here. A
 * browser silently drops the header because it is a forbidden one, so the
 * value is harmless there and does the right thing under Node.
 *
 * This is a classic script, not a module: there is no `import` or `export`
 * anywhere on this page. What this file offers is put on `NwsWeather`, a plain
 * object on the global, and the next script reads it from there. The snapshot
 * tool runs this same file under Node, which is why it looks for `globalThis`
 * rather than `window`.
 */
(function (root) {
  'use strict';

  const BASE = 'https://api.weather.gov';
  const USER_AGENT = 'lattice-grid-demo-nws-weather/1.0 (public demo; contact: support@latticegrid.dev)';

  /**
   * The ten airports the dashboard reads. Their station codes are stable and
   * well-known; the city is a short label for the two-line cell, kept here
   * because the API's station name is a long airport title rather than a place.
   */
  const STATION_INFO = {
    KATL: { city: 'Atlanta, GA' },
    KORD: { city: 'Chicago, IL' },
    KDEN: { city: 'Denver, CO' },
    KLAX: { city: 'Los Angeles, CA' },
    KSEA: { city: 'Seattle, WA' },
    KJFK: { city: 'New York, NY' },
    KDFW: { city: 'Dallas\u2013Fort Worth, TX' },
    KMIA: { city: 'Miami, FL' },
    KBOS: { city: 'Boston, MA' },
    KSFO: { city: 'San Francisco, CA' },
  };

  const CURATED_STATIONS = Object.keys(STATION_INFO);

  /** The subset the rolling charts follow. */
  const CHART_STATIONS = ['KATL', 'KORD', 'KDEN', 'KLAX'];

  /** How long a reading stays in the rolling window: two days. */
  const WINDOW_MS = 48 * 60 * 60 * 1000;

  /** How often the page asks for fresh observations. The API updates often. */
  const OBSERVATIONS_POLL_MS = 10 * 60 * 1000;

  /** How often the page asks for alerts. Warnings change quickly. */
  const ALERTS_POLL_MS = 5 * 60 * 1000;

  /** How many observations per station to pull back. The API caps a request
      at 500, which covers roughly two days of five-minute readings. */
  const SERIES_LIMIT = 500;

  /** The order the snapshot stores an observation row in. */
  const OBSERVATION_COLUMNS = ['id', 'station', 'name', 'city', 'temp', 'windSpeed', 'windDirection', 'humidity', 'pressure', 'text', 'time'];

  /** The order the snapshot stores an alert row in. */
  const ALERT_COLUMNS = ['id', 'event', 'type', 'severity', 'headline', 'description', 'areaDesc', 'effective', 'expires', 'sent'];

  /** Fetch JSON from the API. The service is a shared national one, so a short
      pause and retry beats giving up. */
  async function requestJson(url, describe, opts = {}) {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, {
        signal: opts.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`The ${describe} answered ${response.status}.`);
    }
  }

  /** The numeric value of a measured quantity, or null when there is none. */
  function valueOf(measure) {
    if (!measure) return null;
    const value = measure.value;
    return typeof value === 'number' ? value : null;
  }

  /** Barometric pressure arrives in pascals; the page shows hectopascals. */
  function toHectopascals(measure) {
    const value = valueOf(measure);
    return value == null ? null : Math.round(value / 10) / 100;
  }

  /** Turn one observation into a flat row. */
  function toObservationRow(stationId, props) {
    const info = STATION_INFO[stationId] || { city: stationId };
    const time = props.timestamp ? Date.parse(props.timestamp) : null;
    return {
      kind: 'observation',
      id: stationId,
      station: stationId,
      name: props.stationName || stationId,
      city: info.city,
      temp: valueOf(props.temperature),
      windSpeed: valueOf(props.windSpeed),
      windDirection: valueOf(props.windDirection),
      humidity: valueOf(props.relativeHumidity),
      pressure: toHectopascals(props.barometricPressure),
      text: props.textDescription || '',
      time: Number.isFinite(time) ? time : null,
      count: 1,
    };
  }

  /** Classify an alert's event name into a Warning / Watch / Advisory / Statement. */
  function classifyType(event) {
    const name = String(event || '');
    if (/warning/i.test(name)) return 'Warning';
    if (/watch/i.test(name)) return 'Watch';
    if (/advisory/i.test(name)) return 'Advisory';
    if (/statement/i.test(name)) return 'Statement';
    if (/outlook/i.test(name)) return 'Outlook';
    return 'Alert';
  }

  /** Turn one active alert into a flat row. */
  function toAlertRow(item) {
    const p = item.properties || {};
    const id = p.id || String((item.id || '').split('/').pop());
    if (!id) return null;
    return {
      kind: 'alert',
      id: String(id),
      event: p.event || '',
      type: classifyType(p.event),
      severity: p.severity || 'Unknown',
      headline: p.headline || '',
      description: p.description || '',
      areaDesc: p.areaDesc || '',
      effective: p.effective ? Date.parse(p.effective) : null,
      expires: p.expires ? Date.parse(p.expires) : null,
      sent: p.sent ? Date.parse(p.sent) : null,
      count: 1,
    };
  }

  /** The latest observation at one station. */
  async function fetchLatestObservation(stationId, opts = {}) {
    const body = await requestJson(
      `${BASE}/stations/${stationId}/observations/latest`,
      `latest observation for ${stationId}`,
      opts,
    );
    return toObservationRow(stationId, body.properties || {});
  }

  /**
   * A rolling window of observations for one station, oldest first.
   *
   * @returns {Promise<object[]>} rows `{ id, station, time, temp, windSpeed }`
   */
  async function fetchStationSeries(stationId, opts = {}) {
    const body = await requestJson(
      `${BASE}/stations/${stationId}/observations?limit=${SERIES_LIMIT}`,
      `observations for ${stationId}`,
      opts,
    );
    const rows = [];
    for (const item of body.features || []) {
      const p = item.properties || {};
      const time = p.timestamp ? Date.parse(p.timestamp) : NaN;
      if (!Number.isFinite(time)) continue;
      rows.push({
        id: `${stationId}@${time}`,
        station: stationId,
        time,
        temp: valueOf(p.temperature),
        windSpeed: valueOf(p.windSpeed),
      });
    }
    return rows;
  }

  /** Every active weather alert across the country. */
  async function fetchAlerts(opts = {}) {
    const body = await requestJson(`${BASE}/alerts/active`, 'active alerts feed', opts);
    const rows = [];
    for (const item of body.features || []) {
      const row = toAlertRow(item);
      if (row) rows.push(row);
    }
    return rows;
  }

  /**
   * Read everything the page starts from: the latest observation at each
   * airport, the active alerts, and a two-day window of observations for each.
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   * @returns {Promise<{observations: object[], alerts: object[], series: object, curated: object[]}>}
   */
  async function fetchInitial(opts = {}) {
    const report = opts.onProgress || (() => {});
    report('Reading the active weather alerts...', 0.1);
    const alerts = await fetchAlerts(opts);

    report('Reading the latest observations...', 0.4);
    const latest = await Promise.all(
      CURATED_STATIONS.map((id) => fetchLatestObservation(id, opts).catch(() => null)),
    );
    const observations = latest.filter(Boolean);

    report('Reading two days of observations...', 0.7);
    const lists = await Promise.all(
      CURATED_STATIONS.map((id) => fetchStationSeries(id, opts).catch(() => [])),
    );
    const series = {};
    CURATED_STATIONS.forEach((id, index) => {
      const rows = lists[index] || [];
      rows.reverse(); // oldest first, so the chart reads left to right
      series[id] = rows;
    });

    const byId = new Map(observations.map((o) => [o.id, o]));
    const curated = CURATED_STATIONS.map((id) => ({
      id,
      city: STATION_INFO[id].city,
      name: (byId.get(id) || {}).name || id,
    }));

    report('Building the dashboard...', 1);
    return { observations, alerts, series, curated };
  }

  /**
   * Poll for fresh observations and alerts, and report each result.
   *
   * @param {object} opts
   * @param {(result: object) => void} opts.onPoll called with each successful poll
   * @param {(error: Error) => void} [opts.onError] called when a poll fails
   * @param {number} [opts.intervalMs] how often to poll
   * @returns {{stop: Function, pollNow: Function}} a handle that stops the polling
   */
  function startPolling({ onPoll, onError, intervalMs = OBSERVATIONS_POLL_MS }) {
    let stopped = false;
    let timer = null;
    const controller = new AbortController();

    const runOnce = async () => {
      if (stopped) return;
      try {
        const latest = await Promise.all(
          CURATED_STATIONS.map((id) => fetchLatestObservation(id, { signal: controller.signal }).catch(() => null)),
        );
        const observations = latest.filter(Boolean);
        const alerts = await fetchAlerts({ signal: controller.signal });
        const lists = await Promise.all(
          CURATED_STATIONS.map((id) => fetchStationSeries(id, { signal: controller.signal }).catch(() => [])),
        );
        const series = {};
        CURATED_STATIONS.forEach((id, index) => {
          const rows = lists[index] || [];
          rows.reverse();
          series[id] = rows;
        });
        if (!stopped) onPoll({ observations, alerts, series, fetchedAt: Date.now() });
      } catch (error) {
        if (!stopped && onError) onError(error);
      }
    };

    timer = setInterval(runOnce, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        controller.abort();
      },
      pollNow: runOnce,
    };
  }

  /* ---------------- the snapshot ---------------- */

  /** Pack an observation row into its compact array form. */
  function encodeObservation(row) {
    return OBSERVATION_COLUMNS.map((col) => row[col]);
  }

  /** Pack an alert row into its compact array form. */
  function encodeAlert(row) {
    return ALERT_COLUMNS.map((col) => row[col]);
  }

  /** Unpack a compact observation array back into a row. */
  function decodeObservation(values) {
    const row = {};
    OBSERVATION_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.kind = 'observation';
    row.count = 1;
    return row;
  }

  /** Unpack a compact alert array back into a row. */
  function decodeAlert(values) {
    const row = {};
    ALERT_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.kind = 'alert';
    row.count = 1;
    return row;
  }

  /** Read the saved copy that ships with the demo. */
  async function readSnapshot() {
    const [observations, alerts, series, meta] = await Promise.all(
      ['observations', 'alerts', 'series', 'meta'].map(async (name) => {
        const response = await fetch(`./data/snapshot/${name}.json`);
        if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
        return response.json();
      }),
    );
    const decodedSeries = {};
    for (const id of Object.keys(series)) {
      decodedSeries[id] = series[id].map(([time, temp, windSpeed]) => ({
        id: `${id}@${time}`,
        station: id,
        time,
        temp,
        windSpeed,
      }));
    }
    return {
      observations: observations.map(decodeObservation),
      alerts: alerts.map(decodeAlert),
      series: decodedSeries,
      meta: { ...meta, live: false },
    };
  }

  root.NwsWeather = Object.assign(root.NwsWeather || {}, {
    BASE,
    USER_AGENT,
    STATION_INFO,
    CURATED_STATIONS,
    CHART_STATIONS,
    WINDOW_MS,
    OBSERVATIONS_POLL_MS,
    ALERTS_POLL_MS,
    SERIES_LIMIT,
    OBSERVATION_COLUMNS,
    ALERT_COLUMNS,
    fetchLatestObservation,
    fetchStationSeries,
    fetchAlerts,
    fetchInitial,
    startPolling,
    toObservationRow,
    toAlertRow,
    encodeObservation,
    encodeAlert,
    decodeObservation,
    decodeAlert,
    readSnapshot,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
