# BRASA

**Burning Records Across Satellites, Aligned.** A harmonized MODIS + VIIRS burning activity calendar, 2000 to today, for the Philippines or any area you draw on the map.

Student Innovation Project (SIP) 2026-2027
**Tsygankov, Andrei** · Living Stone International School · Grade 10-J student

The app runs locally, keeps its state in the URL, and needs no account and no server setup beyond a static file server.

## What it does

Two satellites, one record. MODIS (Terra from 2000, Aqua from 2002) is the only active-fire record long enough to say what "normal" looks like. VIIRS (S-NPP from 2012, then NOAA-20/21) flies the same 13:30 orbit with 375 m pixels, so it sees several times more hotspots. Splicing the two together produces a fire surge that never happened: in the Philippines the raw VIIRS/MODIS count ratio is 9.73x over the overlap months.

BRASA removes that jump, so the calendar is about fires and not about which sensor was flying.

- **Year x month calendar**, Nov 2000 to the current month, with annual totals, the baseline median row, the data-source era, uncertainty marks and incomplete-data marks.
- **Any area of interest.** Draw a polygon or rectangle, type latitude/longitude and a radius, upload GeoJSON, or use the whole country. Counts are area-weighted on a 0.1 degree grid, so an odd shape still works.
- **Anomalies** against a multi-year median (default baseline 2003-2022, the target year excluded from its own baseline): percentile rank, robust z-score, colour-blind-safe diverging ramp.
- **"Is this month unusual?"** answers for the current month even when only days 1 to N exist, by comparing the same days across past years.
- **Indicators:** fire-season window (80 % of activity), peak month, most active years, Theil-Sen trend with a Mann-Kendall test.
- **Situation summary** written in plain English or Filipino.
- **Map** (MapLibre) with the harmonized grid, the clicked month's hotspots, and NASA GIBS true colour underneath.
- **Live layer**: last 3 days straight from the FIRMS API (bring a free MAP_KEY).
- **Downloads**: hotspot CSV clipped exactly to the area of interest, monthly analytics CSV with 90 % intervals, calendar PNG/SVG, JSON report, shareable URL.
- **Interface**: English and Filipino, CVD-safe ramps, keyboard-navigable calendar, table view, dark mode, mobile layout.

## Run it

On Windows, double-click **`start.bat`**. It installs dependencies on the first run, starts the development server and opens the browser at http://localhost:5173. `start.bat prod` builds the production bundle and serves it at http://localhost:4173.

From a terminal:

```bash
cd web
npm install
npm run dev
```

A finished build is in `web/dist`. It is a static folder: any file server works, for example `cd web/dist && python -m http.server 8000`.

## Data

Fire data: NASA FIRMS, MODIS Collection 6.1 and VIIRS 375 m (S-NPP, NOAA-20), Standard Processing and NRT. Fire data is pulled through the NASA FIRMS API; the current year comes from the API and the archive years from the yearly FIRMS files.

*We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS).*

Imagery: NASA GIBS. Basemaps: OpenFreeMap / OpenStreetMap contributors. Boundaries: Natural Earth.

Not an official NASA product, no endorsement implied. A hotspot is a satellite detection of a fire pixel, not a confirmed fire, and not burned area.

## Repository layout

```
pipeline/            Python data pipeline (polars)
  fetch.py           FIRMS yearly archives + API for the current year
  fill_years.py      backfill slow archive years through parallel API windows
  fill_range.py      download a date range for one sensor (e.g. NOAA-20)
  process.py         normalize, clip to country, NRT static-source flags
  harmonize.py       dedup, calibration, validation, uncertainty, outages
  export_web.py      compact binary/JSON files for the web app
  test_harmonize.py  synthetic-data tests
  regions.json       regions to build
web/                 Vite + TypeScript + MapLibre + D3 static app
  public/data/       generated data, committed so the folder is ready to serve
  src/               app, charts, i18n (English / Filipino)
LICENSE              MIT
```

## Rebuild the data

```bash
cd pipeline
pip install -r requirements.txt
echo FIRMS_MAP_KEY=your_key > .env
python fetch.py --countries Philippines:PHL
python process.py Philippines
python harmonize.py Philippines
python export_web.py
```

Free FIRMS key: https://firms.modaps.eosdis.nasa.gov/api/map_key/. The archive part of the download needs no key. To add another country, put it in `regions.json` and in `--countries`, spelled as FIRMS spells it.

## Tests

```bash
cd web && npm test
cd pipeline && python -m pytest -q
```

## Note on how it was built

The design and the architecture are mine: what the pipeline has to do and in what order, which screens exist and which deliberately do not, how the calibration is set up and why Aqua MODIS is the reference. I worked the method out on the FIRMS record first, then a coding assistant (Claude Code) typed the modules to that plan; Claude Code also produced first drafts of some prose, which I edited. Every number in the app and in the downloads comes out of `pipeline/` on the public NASA data above and can be re-run.

## License

MIT, see [LICENSE](LICENSE). The licence text also opens inside the app from the **MIT License** button in the header and in the footer.
