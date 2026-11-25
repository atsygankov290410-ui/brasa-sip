"""Download NASA FIRMS active-fire archives (MODIS C6.1 + VIIRS S-NPP 375 m).

Two sources are used:

1. FIRMS yearly country archives (public, no key):
   https://firms.modaps.eosdis.nasa.gov/data/country/<sensor>/<year>/<sensor>_<year>_<Country>.csv
   These contain the Standard Processing (SP) science-quality record, including
   the ``type`` field (0 = presumed vegetation fire, 1 = volcano,
   2 = other static land source, 3 = offshore).

2. FIRMS Area API (needs a free MAP_KEY) for the current year, which is not yet
   in the yearly archive (SP up to ~3 months ago, NRT afterwards):
   https://firms.modaps.eosdis.nasa.gov/api/area/csv/<KEY>/<SOURCE>/<W,S,E,N>/<DAYS 1-5>/<DATE>
   Points are later clipped to the country polygon in ``process.py``.

Usage:
    python fetch.py --countries Philippines:PHL
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
BASE = "https://firms.modaps.eosdis.nasa.gov"
UA = {"User-Agent": "harmonized-fire-calendar/1.0 (research pipeline)"}

# Archive sensor slug -> first year available
ARCHIVES = {"modis": 2000, "viirs-snpp": 2012}


def load_key() -> str | None:
    key = os.environ.get("FIRMS_MAP_KEY")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("FIRMS_MAP_KEY="):
                key = line.split("=", 1)[1].strip()
    return key or None


def download(url: str, dest: Path, retries: int = 4) -> str:
    if dest.exists() and dest.stat().st_size > 0:
        return f"cached  {dest.name}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
                while chunk := r.read(1 << 16):
                    f.write(chunk)
            tmp.replace(dest)
            return f"ok      {dest.name} ({dest.stat().st_size/1e6:.1f} MB)"
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return f"missing {dest.name}"
            err = e
        except Exception as e:  # network hiccup -> retry
            err = e
        time.sleep(5 * attempt)
    return f"FAILED  {dest.name}: {err}"


def archive_jobs(country: str, last_year: int):
    for sensor, first in ARCHIVES.items():
        for year in range(first, last_year + 1):
            url = f"{BASE}/data/country/{sensor}/{year}/{sensor}_{year}_{country}.csv"
            yield url, RAW / country / sensor / f"{year}.csv"


def availability(key: str) -> dict[str, tuple[dt.date, dt.date]]:
    url = f"{BASE}/api/data_availability/csv/{key}/ALL"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        rows = r.read().decode().strip().splitlines()[1:]
    out = {}
    for row in rows:
        k, a, b = row.split(",")
        out[k] = (dt.date.fromisoformat(a), dt.date.fromisoformat(b))
    return out


def api_jobs(country: str, bbox: str, key: str, start: dt.date, end: dt.date):
    """Area API returns at most 5 days per request. Prefer SP, fall back to NRT."""
    avail = availability(key)
    for sp, nrt in (("MODIS_SP", "MODIS_NRT"), ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT")):
        d = start
        while d <= end:
            sp_end = avail.get(sp, (None, dt.date.min))[1]
            source = sp if d + dt.timedelta(days=4) <= sp_end else nrt
            url = f"{BASE}/api/area/csv/{key}/{source}/{bbox}/5/{d.isoformat()}"
            yield url, RAW / country / "api" / source / f"{d.isoformat()}.csv"
            d += dt.timedelta(days=5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--countries", nargs="+",
                    default=["Philippines:116.9,4.5,126.7,21.2"],
                    help="FIRMS country file name and W,S,E,N bbox for the API part")
    ap.add_argument("--last-year", type=int, default=dt.date.today().year)
    ap.add_argument("--nrt-from", default=None,
                    help="First date (YYYY-MM-DD) to pull through the API; default = Jan 1 of last year")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--skip-archive", action="store_true")
    args = ap.parse_args()

    key = load_key()
    jobs = []
    for spec in args.countries:
        name, bbox = spec.split(":")
        if not args.skip_archive:
            jobs += list(archive_jobs(name, args.last_year - 1))
        if key:
            start = dt.date.fromisoformat(args.nrt_from) if args.nrt_from else dt.date(args.last_year, 1, 1)
            jobs += list(api_jobs(name, bbox, key, start, dt.date.today()))
        else:
            print("! FIRMS_MAP_KEY not set: skipping recent NRT data", file=sys.stderr)

    print(f"{len(jobs)} files to fetch with {args.workers} workers")
    with cf.ThreadPoolExecutor(args.workers) as ex:
        for msg in ex.map(lambda j: download(*j), jobs):
            print(msg.replace(key or "\0", "<KEY>"), flush=True)


if __name__ == "__main__":
    main()
