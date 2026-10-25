---
title: Mixed Latin and CJK input — measurement and routing design
description: How often addresses mix Latin and CJK script, how the shipped families parse them, and how to route them.
---

# Mixed Latin and CJK input: measurement and routing design

Issue #2845. Every figure below is observed on 2026-10-25 unless marked otherwise.

## What the corpus holds

v0.8.2 holds 675,547,005 rows. 6,072,644 of them (0.90%) contain both Han, Kana or Hangul and a run of two or more
Latin letters. `wof-admin` writes 6,053,636 of those (99.7%). Each is a localized self name joined to English
ancestors (`フェアモント, WV, United States of America`, `博韦, OISE`), because the adapter rendered every ancestor
with its canonical English name. Mixed addresses as people write them (a Han shop name before a US street, a
Latin building name after a Tokyo address) reach the corpus only through `osm-cn` (15,599 rows), `osm-hk` (2,400)
and a few hundred rows of other sources.

The localized-hierarchy change on this branch writes a record's hierarchy wholly in the language of its preferred
name (`ブルックリン区 / ニューヨーク / ニューヨーク州`), so the next `wof-admin` build replaces most of these
artificial mixed rows with single-script rows.

## What the world holds

In the Overture place-names file for release 2026-09-23.1 (30,919,122 names):

| country |      names |       with CJK | mixing CJK and Latin |
| ------- | ---------: | -------------: | -------------------: |
| US      | 11,834,901 | 2,707 (0.023%) |                2,095 |
| CA      |    758,049 |   596 (0.079%) |                  413 |
| GB      |  1,575,728 |   264 (0.017%) |                  208 |
| FR      |    749,353 |   156 (0.021%) |                   77 |
| AU      |    606,693 |   465 (0.077%) |                  357 |

| country |     names |       Latin only | mixing CJK and Latin |
| ------- | --------: | ---------------: | -------------------: |
| JP      | 1,254,958 | 144,581 (11.52%) |       89,469 (7.13%) |
| KR      |    86,914 |  13,561 (15.60%) |        5,312 (6.11%) |
| TW      |   379,014 |   30,547 (8.06%) |       35,761 (9.44%) |
| HK      |    42,973 |  22,134 (51.51%) |        4,010 (9.33%) |

A CJK name inside a Latin-script country is rare. A Latin or mixed name inside a CJK-script country is common: one
place name in five in Japan carries Latin letters.

## How the shipped families parse them

Shipped CLI (`mailwoman parse`, en-us int8 md5 `5356ecba`), on hand-written inputs. These show behavior on chosen
examples and give no rate.

| input                                                                     | family | result                                                          |
| ------------------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| `Four Seasons Inn 四季酒家, 684 N Spring St, Los Angeles, CA 90012`       | Latin  | correct; the venue span holds the Han name                      |
| `大華超級市場 Hong Kong Supermarket, 157 Hester St, New York, NY 10013`   | Latin  | correct                                                         |
| `新宿ミロード Shinjuku Mylord, 1-1-3 Nishishinjuku, Shinjuku City, Tokyo` | Latin  | correct apart from the city                                     |
| `東京都渋谷区道玄坂2-24-1 Shibuya Mark City`                              | Latin  | street `東京都渋谷区道玄坂2`, locality `Shibuya Mark City`      |
| `Starbucks 東京都渋谷区宇田川町21-1`                                      | Latin  | dependent_locality `Starbucks`, street `東京都渋谷区宇田川町21` |
| `台北市信義區信義路五段7號 Taipei 101`                                    | Latin  | street holds the whole Han address                              |
| `서울특별시 강남구 테헤란로 152 Gangnam Finance Center`                   | Latin  | venue `서울특별시`, street `강남구 테헤란로`                    |
| `McDonald's 新宿東口店, 東京都新宿区新宿3-25-1`                           | CJK    | region `McDonald`, venue `東京`                                 |

A Latin address carrying a CJK name parses. A CJK address carrying a Latin name fails in whichever family it
reaches, because the router sends the whole input to one family and neither family has seen the other script's
address structure.

## What C5 costs on them

On the five mixed inputs above, the current vocabulary writes 118 pieces with no byte fallback, and C5 writes 118
pieces with 6 byte-fallback pieces (5.1%): `超` and `號`, three bytes each. C5 excludes CJK-dominant rows from its
training text by design, so Han characters outside its seeded and sampled set fall back to bytes. On the Latin
family's real traffic the cost is bounded by the 0.02–0.08% of names above. The CJK-country inputs, where the
cost would be large, are the ones that should not reach the Latin family at all.

## Routing design

Three options were considered.

1. **Route by the script of the address body.** Split the input at commas and script boundaries, find the run that
   holds the address structure (a house number, a postcode shape, an admin suffix such as `都`, `区`, `市`), and send
   the input to that run's family. The other-script runs reach the chosen family as a name it already handles,
   which works for the Latin family today (`Four Seasons Inn 四季酒家`).
2. **Run both families and keep the more confident parse.** This needs the two families' confidences on one scale.
   They are calibrated separately, so the comparison is unknown without a calibration study, and it doubles the
   inference cost of every mixed input.
3. **One model for both scripts.** This is the from-scratch merge of the character graph and the Latin graph,
   which the vocabulary audit (2026-10-09) rejected on cost.

Decided: option 1, in two steps. The router first chooses the family from the address body's script rather than
from the whole input's script dominance. The CJK family's training mix then gains rows with a Latin name before or
after the address. The corpus already has the material: 144,581 Latin-only and 89,469 mixed JP names in Overture,
attached to JP addresses through the POI layer. The board rows `jp-grouping-corner-bracket-building` and the inputs in
the table above are the first grading set.

The smallest test that distinguishes option 1 from the current router is the eight inputs above, parsed with the
router change and no retraining. The CJK body with a Latin name should improve at once on the CJK family. The
Latin-body rows should be unchanged.
