"""Fill specific family-years through the FIRMS Area API (parallel 5-day windows).
Used when a yearly archive file is too slow to download. Usage:
    python fill_years.py Philippines 116.9,4.5,126.7,21.2 VIIRS_SNPP_SP 2020 2022
"""
import concurrent.futures as cf
import datetime as dt
import sys

from fetch import BASE, RAW, download, load_key

name, bbox, source, *years = sys.argv[1:]
key = load_key()
jobs = []
for y in map(int, years):
    d = dt.date(y, 1, 1)
    while d.year == y:
        jobs.append((f"{BASE}/api/area/csv/{key}/{source}/{bbox}/5/{d.isoformat()}", RAW / name / "api" / source / f"{d.isoformat()}.csv"))
        d += dt.timedelta(days=5)
print(len(jobs), "requests")
with cf.ThreadPoolExecutor(16) as ex:
    for msg in ex.map(lambda j: download(*j), jobs):
        if not msg.startswith(("ok", "cached")):
            print(msg.replace(key, "<KEY>"), flush=True)
print("done")
