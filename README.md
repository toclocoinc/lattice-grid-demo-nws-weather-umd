# Weather across the United States, live

A live dashboard of the National Weather Service's observation and alert feeds:
the latest reading at ten major US airports, every active weather alert
currently in force, and rolling temperature and wind charts for four of the
airports, built on Lattice Grid loaded by `<script>` tag: no npm install, no
bundler, no build step, no `type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-nws-weather-umd/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |
| The same demo as an ESM package | [lattice-grid-demo-nws-weather](https://github.com/toclocoinc/lattice-grid-demo-nws-weather) |

It is two live feeds fanned through one data router: the observations feed (one
row per airport, its latest reading) and the alerts feed (the alerts and
warnings the National Weather Service has currently raised). The router
partitions them by `kind`, so the two tables never mix. Eight rolling line
charts — temperature and wind speed for four airports — follow the last two
days of readings.

The point of the demo is live, keyless data with a rolling window. The API needs
no key and answers with open cross-origin headers, so the browser reads it
directly; the page polls every ten minutes and each new observation lands on its
airport's chart, pushing the oldest reading out of the two-day window.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.latticegrid.dev/lattice-grid@1.111.7/lattice-grid.min.css?v=20261022">

<script src="https://cdn.latticegrid.dev/lattice-grid@1.111.7/lattice-grid.min.js?v=20261022"></script>
<script src="https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/charts.min.js?v=20261022"></script>
<script src="https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/data-router.min.js?v=20261022"></script>
<script src="https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/kpi.min.js?v=20261022"></script>
<script src="https://cdn.latticegrid.dev/lattice-grid@1.111.7/modules/tabs.min.js?v=20261022"></script>
```

Each file is the package's UMD build and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `createHeadlessGrid`, `setLicence` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | `createDataRouter` |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | `createTabs` |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything.

Every address names the exact release, `1.111.7`, and carries a `?v=` cache stamp.

The demo's own code is four classic scripts, loaded in order: `src/licence.js`,
`src/nws-feed.js`, `src/dashboard.js`, `main.js`. Each file wraps itself in a
function and puts what it offers on one plain object, `NwsWeather`, for the next
file to read. `src/dashboard.js` is handed the grid's factories as arguments
and never touches a global itself.

## Running it

You need nothing but a browser and a way to serve the folder, because the page
fetches its data with `fetch()` and browsers will not do that from `file://`:

```
node tools/serve.mjs
```

| Address | What you get |
| --- | --- |
| `/` | live, reading the National Weather Service API and polling every ten minutes |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no API needed |

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

## What it shows

**One stream, two tables.** The observations feed and the alerts feed both carry
a `kind`, and the router splits them into the "Observations" table (one row per
airport) and the "Alerts" table (one row per alert). A pushed alert lands in the
alerts table and never leaks into the observations table.

**Two-line cells.** The observations table reads each station as its name over
its city; the alerts table reads each alert as its event over the affected
area. The bold primary line carries the identifying field and the quieter line
the disambiguating one.

**Pills that read as colours.** Alert severity is a pill — `Extreme` and
`Severe` in danger, `Moderate` in warning, `Minor` in info — and the alert's
type is a second pill mapping `Warning`, `Watch` and `Advisory` to the same
tones. The type is classified from the event name, because the National Weather
Service's raw `messageType` is only ever `Alert` or `Update`.

**Data bars.** Relative humidity is a bar from 0 to 100 percent and wind speed
a bar against a 60 km/h scale, so a reading's magnitude is visible before its
number is read.

**Rolling-window charts.** Four airports — Atlanta, Chicago, Denver and Los
Angeles — each get a headless grid holding the last two days of readings, and a
temperature and a wind-speed line chart bound to it. As the feed arrives, new
points enter on the right and old ones leave on the left.

**Figures that follow the table.** The strip of tiles reads the observations
table: stations in view, how many reported in the last hour, the average
temperature, and the warmest and coldest stations. The alert tiles read the
same stream the alerts table does — the router feeds them directly, so the
active-alert count is live before the alerts tab is ever opened.

**Temperature that reads as a heat scale.** The temperature column carries a
heat scale as runtime formatting state: blue is cold, red is hot. It is a
formatting rule a reader can open the Formatting panel and change, rather than
a fixed colour written into the page.

**A feed that can fail.** If a poll cannot reach the National Weather Service
the page says so and keeps showing what it already had. If the API cannot be
reached when the page first opens, it shows the saved copy instead and says so
under the title.

## The data

Everything comes from the National Weather Service API:

- <https://www.weather.gov/documentation/services-web-api>

The page reads the active alerts, the latest observation at each airport, and a
two-day window of observations for each:

- `https://api.weather.gov/alerts/active`
- `https://api.weather.gov/stations/{stationId}/observations/latest`
- `https://api.weather.gov/stations/{stationId}/observations?limit=N`

The API is public, needs no key, and answers with open cross-origin headers, so
the browser reads it directly. The data are a US government work and are in the
public domain.

A few things worth knowing about the data:

- Temperature is in degrees Celsius and wind speed in kilometres per hour, the
  units the API returns. Wind direction is degrees from north.
- Barometric pressure arrives in pascals; the page shows hectopascals (a pascal
  reading divided by a hundred), which is what a barometer shows.
- Observations arrive every few minutes from each airport's automated station,
  so a two-day window is a few hundred points per station. The API caps a
  request at 500 observations, which is roughly two days.
- The ten airports are a curated list, not the whole network. Their station
  codes are stable; the city shown under each name is a short label kept in the
  feed, because the API's station name is a long airport title rather than a
  place.
- An alert's `messageType` is only `Alert` or `Update` in this feed. The
  "Warning / Watch / Advisory" classification the page shows is derived from the
  event name, where the familiar wording actually lives.
- Alerts change constantly: the saved copy records whatever was in force when
  it was taken, and the count will not match a later live view.

## Files

```
index.html                page shell, and the six library tags
main.js                   works out where the data comes from, then starts
src/licence.js            the key for this demo's own published address
src/nws-feed.js           the API: observations, alerts, polling, snapshot
src/dashboard.js          the views: router, tables, tiles, rolling charts
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works without the API
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

## Building the saved copy

```
node tools/build-snapshot.mjs
```

It reads the active alerts, the latest observation at each airport and two days
of observations for each, then writes compact arrays to `data/snapshot/`.
Re-run it to refresh the copy.

## Checking it

```
node tools/verify.mjs        # open the page in a real browser and assert
node tools/verify.mjs --all  # also open the live API
```

`tools/verify.mjs` first insists on how the library arrived: no `type="module"`
script anywhere on the page, five script tags pointing at the pinned release on
the CDN, and each leaving the global it documents.
It then recomputes the headline figures from the saved data and compares them
with what the page is showing, checks the eight rolling charts drew marks, opens
the alerts table and pushes an alert through to prove it lands there and not in
the observations table, and finally blocks the National Weather Service API in
the browser and insists the saved copy appears with a notice saying why. The
GitHub Pages workflow runs it before every publish.

## Licence

The demo code is MIT. See `LICENSE`.

The weather data is from the National Weather Service, a US government work in
the public domain.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

---
Built with [Lattice Grid](https://www.latticegrid.dev), a JavaScript data grid with a Data Router: one live feed keeps grids, charts, boards, Gantt and KPI tiles in step. [Documentation](https://www.latticegrid.dev/docs/) · [Demos](https://www.latticegrid.dev/demos/) · [Licence](https://www.latticegrid.dev/licence/)
