/**
 * The dashboard: two live feeds from the National Weather Service, fanned
 * through one data router into an observations table and an alerts table, with
 * rolling temperature and wind charts drawn from a small set of headless
 * grids.
 *
 * Nothing here fetches anything and nothing here reaches for the grid's
 * globals: every factory is handed in, so this file is the same whether the
 * library arrived by script tag, as it does here, or by import.
 *
 * How the pieces fit together:
 *
 *   the API  ->  the router  ->  the observations grid  ->  the station tiles
 *                             ->  the alerts grid + the alert tiles
 *                             ->  the charts (headless grids)
 *
 * The observations grid holds one row per airport (its latest reading); the
 * alerts grid holds every active weather alert. Both arrive in one stream
 * carrying a `kind`, and the router partitions them on it. The alert tiles are
 * a third viewer on the same stream, fed by the router directly. The rolling
 * charts are a separate concern: one headless grid per curated airport, each
 * holding the last two days of readings and feeding a temperature and a wind
 * chart.
 *
 * A classic script: it reads the constants from `NwsWeather`, put there by
 * `nws-feed.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { WINDOW_MS, CHART_STATIONS } = root.NwsWeather;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A clock time, local to whoever is reading. */
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /**
   * A reading's time as an instant.
   *
   * The grid holds `time` as epoch milliseconds, but a KPI panel bound to the
   * grid hands a tile the grid's own value for a datetime column, which is its
   * wall-clock text rather than the number. It is read back into milliseconds
   * before anything does arithmetic on it.
   *
   * @param {number|string} value a projected or raw time
   * @returns {number|null} epoch milliseconds, or null when it cannot be read
   */
  function timeOf(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  function observationColumns() {
    return [
      {
        title: 'The station',
        columns: [
          {
            id: 'name',
            field: 'name',
            title: 'Station',
            cell: { render: 'twoline', props: { secondary: 'city' } },
            filter: { type: 'text' },
            layout: { width: 270 },
          },
          { id: 'station', field: 'station', title: 'Code', filter: { type: 'set' }, layout: { width: 90 } },
          { id: 'text', field: 'text', title: 'Conditions', filter: { type: 'set' }, layout: { width: 130 } },
        ],
      },
      {
        title: 'The reading',
        columns: [
          { id: 'temp', field: 'temp', title: 'Temperature (\u00B0C)', type: 'number', format: { decimals: 1 }, filter: { type: 'number' }, layout: { width: 130 } },
          { id: 'windSpeed', field: 'windSpeed', title: 'Wind (km/h)', type: 'number', format: { decimals: 1 }, cell: { decoration: 'bar', min: 0, max: 60 }, filter: { type: 'number' }, layout: { width: 120 } },
          { id: 'windDirection', field: 'windDirection', title: 'Wind dir (\u00B0)', type: 'number', format: { decimals: 0 }, layout: { width: 100, hidden: true } },
          { id: 'humidity', field: 'humidity', title: 'Humidity (%)', type: 'number', format: { decimals: 0 }, cell: { decoration: 'bar', min: 0, max: 100 }, filter: { type: 'number' }, layout: { width: 120 } },
          { id: 'pressure', field: 'pressure', title: 'Pressure (hPa)', type: 'number', format: { decimals: 1 }, filter: { type: 'number' }, layout: { width: 120 } },
          { id: 'time', field: 'time', title: 'Last reading', type: 'datetime', filter: { type: 'date' }, sort: { direction: 'desc' }, layout: { width: 160 } },
        ],
      },
      {
        title: 'Count',
        columns: [
          { id: 'count', field: 'count', title: 'Stations', type: 'number', total: 'sum', groupTotal: 'sum', filter: { type: 'none' }, layout: { width: 90, hidden: true } },
        ],
      },
    ];
  }

  function alertColumns() {
    return [
      {
        title: 'The alert',
        columns: [
          {
            id: 'event',
            field: 'event',
            title: 'Event',
            cell: { render: 'twoline', props: { secondary: 'areaDesc' } },
            filter: { type: 'text' },
            layout: { width: 250 },
          },
          { id: 'severity', field: 'severity', title: 'Severity', cell: { decoration: 'pill', variant: severityVariant() }, filter: { type: 'set' }, layout: { width: 120 } },
          { id: 'type', field: 'type', title: 'Type', cell: { decoration: 'pill', variant: typeVariant() }, filter: { type: 'set' }, layout: { width: 120 } },
          { id: 'headline', field: 'headline', title: 'Headline', filter: { type: 'text' }, layout: { width: 320 } },
        ],
      },
      {
        title: 'When',
        columns: [
          { id: 'effective', field: 'effective', title: 'From', type: 'datetime', filter: { type: 'date' }, layout: { width: 160 } },
          { id: 'expires', field: 'expires', title: 'Until', type: 'datetime', filter: { type: 'date' }, layout: { width: 160 } },
          { id: 'count', field: 'count', title: 'Alerts', type: 'number', total: 'sum', groupTotal: 'sum', filter: { type: 'none' }, layout: { width: 90, hidden: true } },
        ],
      },
    ];
  }

  /** The National Weather Service severity, least to most, as a pill tone. */
  function severityVariant() {
    return {
      when: [
        { op: 'eq', value: 'Extreme', use: 'danger' },
        { op: 'eq', value: 'Severe', use: 'danger' },
        { op: 'eq', value: 'Moderate', use: 'warning' },
        { op: 'eq', value: 'Minor', use: 'info' },
      ],
      default: 'neutral',
    };
  }

  /** The alert's classified type, as a pill tone. */
  function typeVariant() {
    return {
      when: [
        { op: 'eq', value: 'Warning', use: 'danger' },
        { op: 'eq', value: 'Watch', use: 'warning' },
        { op: 'eq', value: 'Advisory', use: 'info' },
      ],
      default: 'neutral',
    };
  }

  /**
   * A heat scale over the temperature column, held as runtime formatting state
   * so a reader can open the Formatting panel and change it. Blue is cold,
   * red is hot; the bounds are fixed so a cell's colour means the same thing
   * however the table is filtered.
   */
  function temperatureFormatting() {
    return {
      temp: [
        {
          id: 'heat-scale',
          label: 'Heat scale',
          scale: {
            min: -20,
            max: 45,
            colours: ['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'],
          },
        },
      ],
    };
  }

  function baseGridConfig(title) {
    return {
      rowKey: 'id',
      theme: 'light',
      density: 'comfortable',
      stripedRows: true,
      columnMenu: true,
      groupPanel: true,
      statusBar: true,
      find: true,
      grandTotalRow: 'bottom',
      groupDefaultExpanded: 0,
      toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
      selection: 'multiple',
      highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
      title,
    };
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  function buildDashboard({
    root: host,
    createGrid,
    createHeadlessGrid,
    createChart,
    createKPI,
    createTabs,
    createDataRouter,
    observations,
    alerts,
    series,
    curated,
    meta,
  }) {
    host.textContent = '';

    const built = {
      observationsGrid: null,
      alertsGrid: null,
      router: null,
      kpi: null,
      alertsKpi: null,
      charts: [],
      seriesGrids: {},
      tabs: null,
      store: new Map(),
      status: { lastPoll: null, lastError: null, polls: 0, arrivals: 0, revisions: 0 },
    };

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'Weather across the United States, live'));
    heading.append(
      el(
        'p',
        'lede',
        'Live observations from ten major US airports, updated every ten minutes, with the active weather alerts ' +
          'the National Weather Service has currently raised. The eight charts follow four of the airports over the last two days.',
      ),
    );
    if (meta.fellBack) {
      heading.append(
        el(
          'p',
          'notice',
          'The National Weather Service API could not be reached, so this is the saved copy. Reloading the page will try again.',
        ),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
    const liveDot = el('span', 'dot');
    if (meta.live) modePill.prepend(liveDot);
    const freshness = el('span', 'freshness', 'Waiting for the first update...');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the tiles ---------------- */

    const kpiHost = el('section', 'kpi-strip');
    kpiHost.setAttribute('aria-label', 'Headline figures');
    const stationsPanel = el('div', 'kpi-panel');
    const alertsPanel = el('div', 'kpi-panel');
    const namedWrap = el('div', 'kpi-named-wrap');
    const warmTile = el('div', 'kpi-named');
    const warmValue = el('div', 'kpi-named-value', 'No data');
    const warmLabel = el('div', 'kpi-named-label', 'Warmest station in view');
    warmTile.append(warmValue, warmLabel);
    const coldTile = el('div', 'kpi-named');
    const coldValue = el('div', 'kpi-named-value', 'No data');
    const coldLabel = el('div', 'kpi-named-label', 'Coldest station in view');
    coldTile.append(coldValue, coldLabel);
    namedWrap.append(warmTile, coldTile);
    kpiHost.append(stationsPanel, alertsPanel, namedWrap);
    host.append(kpiHost);

    /* ---------------- the charts ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'Observation charts');
    const chartBoxes = [];
    const metrics = [
      { key: 'temp', y: 'temp', axisLabel: 'Temperature (\u00B0C)', label: 'Temperature (\u00B0C)' },
      { key: 'windSpeed', y: 'windSpeed', axisLabel: 'Wind speed (km/h)', label: 'Wind speed (km/h)' },
    ];
    const chartStations = curated.filter((c) => CHART_STATIONS.includes(c.id));
    for (let i = 0; i < chartStations.length * metrics.length; i += 1) {
      const box = el('div', 'chart-box');
      chartHost.append(box);
      chartBoxes.push(box);
    }
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    /* ---------------- the tables ---------------- */

    const tabsHost = el('section', 'tabs-host');
    host.append(tabsHost);

    const tabs = createTabs(tabsHost, {
      createGrid,
      ariaLabel: 'Weather views',
      tabs: [
        {
          id: 'observations',
          label: 'Observations',
          badge: true,
          config: { ...baseGridConfig('Airport observations and their latest reading'), columns: observationColumns(), formatting: temperatureFormatting(), rows: [] },
        },
        {
          id: 'alerts',
          label: 'Alerts',
          badge: true,
          config: { ...baseGridConfig('Active weather alerts across the country'), columns: alertColumns(), rows: [] },
        },
      ],
    });
    built.tabs = tabs;
    built.observationsGrid = tabs.tab('observations');

    /* ---------------- the tiles, bound to the tables ---------------- */

    const HOUR_MS = 60 * 60 * 1000;

    const kpi = createKPI(stationsPanel, {
      grid: built.observationsGrid,
      rowKey: 'id',
      fields: ['temp', 'windSpeed', 'humidity', 'time', 'name', 'city'],
      columns: 3,
      ariaLabel: 'Station figures',
      tiles: [
        { id: 'stations', label: 'Stations in view', aggregation: 'count', format: 'number' },
        {
          id: 'reporting',
          label: 'Reporting in the last hour',
          aggregation: 'custom',
          format: 'number',
          compute: (rows) => rows.filter((r) => {
            const t = timeOf(r.time);
            return t != null && Date.now() - t <= HOUR_MS;
          }).length,
        },
        { id: 'avgTemp', label: 'Average temperature (\u00B0C)', aggregation: 'avg', field: 'temp', format: { type: 'number', decimals: 1 } },
      ],
    });
    built.kpi = kpi;

    /* The alert tiles are a third viewer on the same stream, fed by the router
       directly rather than by the alerts grid, so they read the whole alert set
       without needing the alerts tab to have been opened yet. */
    const alertsKpi = createKPI(alertsPanel, {
      rowKey: 'id',
      columns: 2,
      ariaLabel: 'Alert figures',
      tiles: [
        { id: 'alerts', label: 'Active alerts', aggregation: 'count', format: 'number' },
        {
          id: 'severe',
          label: 'Severe or extreme',
          aggregation: 'custom',
          format: 'number',
          compute: (rows) => rows.filter((r) => r.severity === 'Severe' || r.severity === 'Extreme').length,
        },
      ],
    });
    built.alertsKpi = alertsKpi;

    /** Name the warmest and coldest stations in view. */
    const refreshNamedTiles = () => {
      let warmest = null;
      let coldest = null;
      built.observationsGrid.rows.forEach((r) => {
        const row = r && r.data;
        if (!row || typeof row.temp !== 'number') return;
        if (!warmest || row.temp > warmest.temp) warmest = row;
        if (!coldest || row.temp < coldest.temp) coldest = row;
      });
      warmValue.textContent = warmest ? `${warmest.name} \u00B7 ${warmest.temp.toFixed(1)}\u00B0C` : 'No data';
      coldValue.textContent = coldest ? `${coldest.name} \u00B7 ${coldest.temp.toFixed(1)}\u00B0C` : 'No data';
    };
    kpi.on('change', refreshNamedTiles);
    refreshNamedTiles();

    /* ---------------- the router ---------------- */

    /*
     * One stream in, three viewers out, split on `kind`. An observation row and
     * an alert row never share an id, so the two tables never claim the same
     * record. The alert tiles are a second viewer on the `alert` partition and
     * the counting subscriber a third on everything, which is what
     * `overlap: true` is for: one row reaches its table, the tiles and the
     * subscriber. The alerts table is built the first time its tab is opened.
     */
    const router = createDataRouter({
      key: (row) => row.kind,
      rowKey: 'id',
      overlap: true,
    });
    built.router = router;

    router.attach(built.observationsGrid, 'observation');
    router.attach(built.alertsKpi, 'alert');
    router.subscribe(() => true, (change) => {
      built.status.arrivals += (change.add || []).length;
      built.status.revisions += (change.update || []).length;
    });

    const ingest = (incoming) => {
      if (!incoming || !incoming.length) return 0;
      for (const row of incoming) built.store.set(`${row.kind}:${row.id}`, row);
      router.apply(incoming.map((row) => ({ op: 'upsert', row })));
      return incoming.length;
    };

    const attachAlerts = () => {
      if (built.alertsGrid) return;
      const grid = tabs.tab('alerts');
      if (!grid) return;
      built.alertsGrid = grid;
      router.attach(grid, 'alert');
      router.load([...built.store.values()]);
    };
    tabs.on('tab:changed', (event) => {
      if (event.id === 'alerts') attachAlerts();
    });

    /* The first load. A snapshot is a keyed diff, so calling this again later
       updates what changed rather than repainting everything. */
    for (const row of [...observations, ...alerts]) built.store.set(`${row.kind}:${row.id}`, row);
    router.load([...built.store.values()]);

    /* ---------------- the rolling charts ---------------- */

    /* The window ends now for live data, and at the moment the saved copy was
       taken for a saved copy; otherwise the copy ages out and the charts empty. */
    const windowEnd = () => (meta.live ? Date.now() : meta.fetchedAtMs || Date.now());
    const trimWindow = (rows) => rows.filter((row) => windowEnd() - row.time <= WINDOW_MS);

    for (const entry of chartStations) {
      try {
        const grid = createHeadlessGrid({
          rowKey: 'id',
          columns: [
            { id: 'time', field: 'time', type: 'datetime' },
            { id: 'temp', field: 'temp', type: 'number', format: { decimals: 1 } },
            { id: 'windSpeed', field: 'windSpeed', type: 'number', format: { decimals: 1 } },
          ],
        });
        built.seriesGrids[entry.id] = grid;
        for (const metric of metrics) {
          const box = chartBoxes.shift();
          const chart = createChart({
            grid,
            container: box,
            type: 'line',
            x: 'time',
            y: metric.y,
            title: `${entry.city} \u2014 ${metric.label}`,
            subtitle: entry.name,
            axis: { y: metric.axisLabel },
            legend: false,
          });
          built.charts.push(chart);
        }
      } catch (error) {
        console.error('[nws demo] chart', entry.id, error);
      }
    }

    /** Push fresh readings into the rolling charts. */
    const updateSeries = (nextSeries) => {
      for (const id of Object.keys(built.seriesGrids)) {
        const grid = built.seriesGrids[id];
        if (!grid) continue;
        const rows = trimWindow((nextSeries && nextSeries[id]) || []);
        grid.rows.load(rows);
      }
    };
    built.updateSeries = updateSeries;
    updateSeries(series);

    /* ---------------- the controls ---------------- */

    const button = (label, onClick, className) => {
      const node = el('button', className || 'action', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    };

    actions.append(el('span', 'actions-label', 'Order by'));
    actions.append(button('Warmest first', () => built.observationsGrid && built.observationsGrid.sort.set([{ col: 'temp', dir: 'desc' }])));
    actions.append(button('Coldest first', () => built.observationsGrid && built.observationsGrid.sort.set([{ col: 'temp', dir: 'asc' }])));
    actions.append(button('Windiest first', () => built.observationsGrid && built.observationsGrid.sort.set([{ col: 'windSpeed', dir: 'desc' }])));

    const staleButton = button('Only stations not reporting this hour', () => {
      const on = staleButton.getAttribute('aria-pressed') === 'true';
      built.observationsGrid.filters.where('stale', on ? null : (row) => {
        const t = timeOf(row.time);
        return t == null || Date.now() - t > HOUR_MS;
      });
      staleButton.setAttribute('aria-pressed', String(!on));
      staleButton.classList.toggle('on', !on);
    }, 'action toggle');
    staleButton.setAttribute('aria-pressed', 'false');
    actions.append(el('span', 'actions-gap'));
    actions.append(staleButton);
    built.staleButton = staleButton;

    const showActionsFor = (id) => {
      actions.hidden = id !== 'observations';
    };
    showActionsFor(tabs.activeId);
    tabs.on('tab:changed', (event) => showActionsFor(event.id));

    /* ---------------- the live readout ---------------- */

    const alertSummary = () => {
      const count = alertsKpi.value('alerts');
      const severe = alertsKpi.value('severe');
      const n = typeof count === 'number' ? count : built.store.size;
      const s = typeof severe === 'number' ? severe : 0;
      if (!n) return 'No active weather alerts.';
      const parts = [];
      if (s) parts.push(`${s} severe or extreme`);
      parts.push(`${n} alert${n === 1 ? '' : 's'}`);
      return `${parts.join(', ')} in force.`;
    };

    const setFreshness = () => {
      if (!meta.live) {
        const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
        freshness.textContent = `A saved copy of the weather data, taken on ${saved}.`;
        freshness.className = 'freshness';
        return;
      }
      if (built.status.lastError) {
        freshness.textContent = built.status.lastPoll
          ? `Could not reach the API. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
          : 'Could not reach the API.';
        freshness.className = 'freshness failed';
        return;
      }
      if (!built.status.lastPoll) {
        freshness.textContent = 'Waiting for the first update...';
        freshness.className = 'freshness';
        return;
      }
      freshness.textContent = `Updated ${clockText(built.status.lastPoll)}. ${alertSummary()}`;
      freshness.className = 'freshness';
    };
    built.setFreshness = setFreshness;

    built.onPoll = (result) => {
      built.status.lastPoll = result.fetchedAt || Date.now();
      built.status.lastError = null;
      built.status.polls += 1;
      liveDot.classList.add('beat');
      setTimeout(() => liveDot.classList.remove('beat'), 900);
      ingest([...result.observations, ...result.alerts]);
      updateSeries(result.series);
      setFreshness();
    };

    built.onPollError = (error) => {
      built.status.lastError = String((error && error.message) || error);
      setFreshness();
      console.warn('[nws demo] a poll failed:', built.status.lastError);
    };

    built.ingest = ingest;
    setFreshness();

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const line = el('p', null, 'Weather data from the ');
    const link = el('a', null, 'National Weather Service API');
    link.href = 'https://www.weather.gov/documentation/services-web-api';
    link.rel = 'noopener';
    line.append(link);
    line.append(
      document.createTextNode(
        ' (api.weather.gov), published by the US government and free to use. Temperature is in degrees Celsius, wind speed in ' +
          'kilometres per hour. Observations arrive every few minutes from each airport\u2019s automated station; alerts appear ' +
          'only while the National Weather Service has one in force.',
      ),
    );
    footer.append(line);

    const builtWith = el('p', null, 'Built with ');
    const builtWithLink = el('a', null, 'Lattice Grid');
    builtWithLink.href = 'https://www.latticegrid.dev/realtime-applications/';
    builtWith.append(builtWithLink);
    footer.append(builtWith);

    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      kpi.destroy();
      alertsKpi.destroy();
      router.destroy();
      tabs.destroy();
    };

    return built;
  }

  root.NwsWeather.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
