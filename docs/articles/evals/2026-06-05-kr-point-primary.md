# Korea resolves to a coordinate. The name is another story.

**Date:** 2026-06-05
**Scope:** the second CJK locale — South Korea coarse resolution. An _inverted_ build (point-primary, not name-primary) feeding the same resolver strategy, why it lands province + sub-kilometre but only 26% name-confirmed, and where the ceiling actually is.

Japan landed at 94% name-matched ([the CJK arena writeup](./2026-06-05-cjk-arena.md)). We pointed the same machinery at Korea expecting a re-run, and Korea handed back a different shape of data — so the build had to invert, and the honest result is a partial: the coordinate and the province come out clean, the administrative _name_ mostly doesn't, and the reason is a gap in the gazetteer, not in the approach.

## The data inverts, so the build inverts

Japan's build is name-primary: ask Japan Post (KEN_ALL) for the municipality name behind a postcode, then find that name in WOF. It works because KEN_ALL ships a romanized edition (`SAPPORO SHI CHUO KU`) in the same alphabet as WOF's romanized place names.

Korea hands you the opposite. The GeoNames postal file for KR already carries `postcode → (place_name, province, latitude, longitude)` in one source — no separate postal-authority fetch — but the names are Hangul (추자면), while WOF's `spr.name` for Korea is romanized (`Chuja-myeon`, except it isn't even that; it's whatever transliteration WOF happened to file). The alphabets don't line up, so name-first matching against `spr.name` is a non-starter. That was the original "KR is blocked" read.

It's only half true. WOF's `names` table _does_ carry Hangul — 13,120 `kor` entries plus ~7,500 Hangul-bearing `und` (undetermined-language) names — so a Hangul-to-Hangul join is possible. And every postcode comes with a coordinate. So Korea's build is point-primary: take the postcode's GeoNames coordinate, find the nearest WOF locality, and use the Hangul name as a _confirmation_ signal where it exists. Different first move, same destination — it writes the identical `postcode_locality` table the `postcode_area_resolution` strategy already reads. That's the part that generalizes: one strategy, a second build shaped to the country's data.

## What lands cleanly: the coordinate and the province

WOF's Korean localities are dense — 21,139 of them, essentially every 동/리 (dong/ri) — so the nearest one to a postcode point is **p50 0.96 km, p90 2.36 km** away. Coordinate resolution is excellent and total: 34,244 of 34,249 postcodes (100%) resolve to a locality point inside a couple of kilometres.

The province is free and exact. GeoNames' `admin1` (제주특별자치도, 강원도, …) matches WOF's region Hangul names **17/17, 100%** — provinces are large and uniquely named, so there's no ambiguity to lose. Any address the parser hands us, we can anchor to the right province and a sub-kilometre coordinate with full coverage. For a geocoder that's already a usable coarse fix.

## What doesn't: the administrative name (26%, and here's why)

The name confirmation only fires for **9,020 / 34,249 postcodes — 26.3%.** Japan was 94.9%. The gap is entirely a data-coverage story, and it has two parts worth naming because they tell you where to dig next.

**Granularity mismatch.** GeoNames' `place_name` is at the eup/myeon/dong level — 추자면 (Chuja-_myeon_). WOF's locality layer is finer, at the ri/village level — so the nearest point to that postcode is "Mung," a hamlet _inside_ Chuja-myeon, spatially dead-on but nominally a different unit. The two sources are both right and don't agree, because they're describing different rungs of the ladder. (This is also why the name-confirmed tier averages 4.8 km while the point tier averages 1.2 km: confirming the name pulls the answer up to the coarser, correctly-named unit, which sits a little farther from the postcode centroid. That's the trade you want from a _coarse_ resolver, so the build prefers it — `is_containing=1`.)

**Missing 구 districts.** The single largest miss bucket is 구 (gu, urban districts) — 9,515 postcodes, the Gangnam-gu / Haeundae-gu level that dominates Seoul and Busan addressing. WOF KR simply doesn't carry these as named localities, so there's nothing to confirm against. The most address-dense slice of the country is the slice WOF is thinnest on.

### One bug worth writing down

The first build reported 56% name-confirmed — and it was wrong. Korean place names repeat heavily across the country (homonymous villages), and the matcher was finding name matches _globally_ and then taking the nearest homonym. The "nearest" 신촌 can be in another province; the name-confirmed tier came out at **71 km mean, 537 km max.** The fix is the same proximity constraint Japan's builder already used: a name only confirms if the matched locality is _also_ within the search radius. That dropped the tier to its honest 26% — and to a 4.8 km mean, 20 km max. Two signals have to agree; one signal pretending to be two is worse than the point alone.

## Verdict: a working coarse resolver, an honest name ceiling

Korea is a partial, and labelling it anything else would be dishonest. Province and coordinate resolve at 100%; the administrative name resolves at 26%, capped by WOF KR's Hangul-name coverage — the ri-granularity offset and the absent 구 districts. The architecture carried over intact (point-primary build, same strategy, no resolver code changed), which is what the "less special" mandate was really testing. What it can't manufacture is admin names WOF doesn't hold.

The path to a Japan-grade KR name tier runs through a better source — Korea's 도로명주소 (Juso) road-name address database, which carries the 구/동 names natively. It's key-walled behind a government API, so it's a deliberate acquisition, not a scrape. Until then, Korea ships as an **experimental** point-primary table: trustworthy for province and coordinate, explicit about the 26% name tier. It is not promoted into the default resolver bundle.

Taiwan is the next CJK locale and a harder start: no GeoNames postal file at all, and `admin-tw.db` isn't even built yet (only the WOF repo is on disk). That one begins one rung lower, by building the admin DB.

### Numbers

| signal                         |                 KR (point-primary) |                JP (name-primary) |
| ------------------------------ | ---------------------------------: | -------------------------------: |
| postcodes                      |                             34,249 |                          124,788 |
| resolved (coordinate)          |                             100.0% |                                — |
| province match (admin1→region) |                             100.0% |                                — |
| name-confirmed (precise tier)  |                          **26.3%** |                        **94.9%** |
| dist p50 / p90 (km)            |                        0.96 / 2.36 |                                — |
| build                          | GeoNames postal + WOF Hangul names | KEN_ALL romaji + GeoNames points |

Build: `scripts/build-postcode-locality-kr.py`. Source: GeoNames postal KR + custom `admin-kr.db` (whosonfirst-data-admin-kr), built from source — no prebuilt dumps.
