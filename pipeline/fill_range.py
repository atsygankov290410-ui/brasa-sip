"""Download a date range for one sensor through the FIRMS Area API (parallel 5-day windows),
switching from Standard Processing to NRT after the last SP date. Usage:
    python fill_range.py Philippines 116.9,4.5,126.7,21.2 VIIRS_NOAA20 2024-01-01 [YYYY-MM-DD]
"""
import concurrent.futures as cf
import datetime as dt
import sys

from fetch import BASE, RAW, availability, download, load_key

name, bbox, sensor, start, *rest = sys.argv[1:]
end = dt.date.fromisoformat(rest[0]) if rest else dt.date.today()
key = load_key()
avail = availability(key)
sp_end = avail.get(f"{sensor}_SP", (None, dt.date.min))[1]
jobs, d = [], dt.date.fromisoformat(start)
while d <= end:
    src = f"{sensor}_SP" if d + dt.timedelta(days=4) <= sp_end else f"{sensor}_NRT"
    jobs.append((f"{BASE}/api/area/csv/{key}/{src}/{bbox}/5/{d.isoformat()}", RAW / name / "api" / src / f"{d.isoformat()}.csv"))
    d += dt.timedelta(days=5)
print(len(jobs), "requests")
with cf.ThreadPoolExecutor(16) as ex:
    for msg in ex.map(lambda j: download(*j), jobs):
        if not msg.startswith(("ok", "cached")):
            print(msg.replace(key, "<KEY>"), flush=True)
print("done")
