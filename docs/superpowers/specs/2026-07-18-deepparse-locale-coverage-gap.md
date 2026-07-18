# Deepparse OOTB locale coverage — the mailwoman gap list

**Date:** 2026-07-18
**Task:** Enumerate every locale/country Deepparse's pretrained models support out of the box, map it
against what mailwoman covers today (parser-model vs gazetteer/resolve — they differ), and rank the
gaps by effort.

Every claim below cites a source: a URL for Deepparse, a `file:line` for mailwoman.

---

## 1. Deepparse OOTB country coverage

Deepparse ships two pretrained models (fastText, BPEmb) trained on a subset of the
libpostal-derived SubwayGroup _structured multinational address_ dataset (Yassine et al.,
["Leveraging Subword Embeddings for Multinational Address Parsing", arXiv:2006.16152](https://arxiv.org/abs/2006.16152)).
The dataset spans **61 countries**, split into a **20-country training set** and a **41-country
zero-shot test set**. Deepparse does **not** group countries into formal "zones" — the only grouping
is trained vs zero-shot.

- Coverage list (train + zero-shot): [Deepparse README, GRAAL-Research/deepparse](https://github.com/GRAAL-Research/deepparse)
  (fetched 2026-07-18) and the [dataset docs](https://deepparse.org/).
- Both pretrained models parse all 61; accuracy is _reported_ on all 61, but only the 20 training
  countries carry supervised signal — the 41 are zero-shot generalization.

### Trained (20) — ISO-3166 alpha-2

| NO     | IT     | GB     | DE     | FR     | NL     | PL     | US     | KR     | ES     |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ |
| **AT** | **MX** | **CH** | **DK** | **BR** | **AU** | **CZ** | **CA** | **RU** | **FI** |

(Norway, Italy, United Kingdom, Germany, France, Netherlands, Poland, United States, South Korea,
Spain, Austria, Mexico, Switzerland, Denmark, Brazil, Australia, Czechia, Canada, Russia, Finland.)

### Zero-shot (41) — ISO-3166 alpha-2

LV, CO, RE, JP, DZ, MY, EE, SI, BM, PH, BA, LT, HR, IE, GR, RS, SE, NZ, IN, CY, ZA, FO, SG, ID, PT,
BE, UA, BD, HU, RO, BY, MD, PY, AR, KZ, BG, NC, VE, IS, UZ, SK.

(Latvia, Colombia, Réunion, Japan, Algeria, Malaysia, Estonia, Slovenia, Bermuda, Philippines,
Bosnia & Herzegovina, Lithuania, Croatia, Ireland, Greece, Serbia, Sweden, New Zealand, India,
Cyprus, South Africa, Faroe Islands, Singapore, Indonesia, Portugal, Belgium, Ukraine, Bangladesh,
Hungary, Romania, Belarus, Moldova, Paraguay, Argentina, Kazakhstan, Bulgaria, New Caledonia,
Venezuela, Iceland, Uzbekistan, Slovakia.)

---

## 2. mailwoman's current coverage

### (a) Trained parser-model coverage — 23 countries

The shipped model's `country_weights` (v3.10.1 span-ship config,
`corpus-python/src/mailwoman_train/configs/v3.10.1-span-ship-8k.yaml:32`) carries supervised
exposure for:

> US, FR, DE, ES, IT, NL, PT, BE, PL, AT, CH, CZ, DK, NO, SE, FI, IE, GB, SK, SI, HR, HU, AU

AU is trained via the `gnaf` source (weight 6.0) in the same block. The tiering of these claims
(which are floor-gated vs thinly measured) is `docs/articles/plan/SCOPE.mdx:44-48`:
Tier 1 US/FR (floor-gated), Tier 2 IT/PT/PL/AT/CZ/DE/AU/BE/ES/NL/CH/HR/DK/FI (coordinate-paneled),
Tier 3 NO/SE (thin), Tier 4 CZ/PL/SK/SI (diacritic splice), Tier 5 JP (resolver-route only, **no
parser training claim**).

### (b) Gazetteer / resolve coverage — much broader

The admin-gazetteer recipe (`mailwoman/gazetteer-pipeline/defaults.ts`) unions three tiers:

- `DEFAULT_WOF_PRIORITY_COUNTRIES` (`defaults.ts:18`) — CN, DE, ES, FR, GB, IT, **JP, KR**, NL, TW, US.
- `DEFAULT_OVERTURE_COUNTRIES` (`defaults.ts:33`) — 86 countries incl. **AU, BR, CA, MX, NZ, RU** and
  most of the EU / LATAM / MENA / APAC.
- `DEFAULT_GEONAMES_COUNTRIES` (`defaults.ts:123`) — 161-country alias-fold tail incl. **BM, BA, CY,
  FO, MD, NC, PY, RE, UZ**.

**Net result: all 61 Deepparse OOTB countries have gazetteer/resolve coverage in mailwoman.** The gap
is entirely on the _parser-model_ side.

---

## 3. The gap

Of Deepparse's 61 OOTB countries, mailwoman has:

- **Trained parser-model coverage: 23** (all 23 of mailwoman's trained countries fall inside
  Deepparse's 61).
- **Gazetteer/resolve coverage: 61** (all of them).
- **Model gap (gazetteer-only, no parser training): 38** — 5 of Deepparse's _trained_ 20, plus 33 of
  its zero-shot 41.

Because every gap country already resolves, "adding" it means: build a corpus shard, add it to
`country_weights`, retrain, and stand up a coordinate-graded eval. Effort is therefore governed by
**whether address-level training data already exists**, not by gazetteer work.

### Ranked by effort

| Rank                                                               | Countries                                                                      | Why this effort                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Data in hand?                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **1 — Deepparse parity gaps, OA/LINZ street data on disk**         | **NZ, CA, MX, BR**                                                             | All four are a `locale`-recipe shard build (`corpus/src/shard-recipes/locale.ts` `COUNTRY_SOURCES`) — extend the map, build a street shard, add to `country_weights`, retrain, coord-grade. **NZ** is the best-provisioned: `openaddresses/extracted/nz/countrywide.csv` = **2.12M** LINZ-derived street rows (verified 2026-07-18; the formatter already renders NZ correctly). CA is OA-dense, MX/BR partial. **CORRECTION (2026-07-18):** NZ was ranked 0 ("declare + retrain, 8,967 rows on disk") on the night-2 postmortem's premise — that is **falsified**. A full census (all 685 v0.5.0 base shards, 676M rows) finds **2,990** NZ rows, not 8,967 (the 8,967 was a first-300k-row artifact of `country_census_raw`'s ordering), and **all 2,990 are `synth-po-box-cedex`** (po_box/locality/postcode/venue, **zero street/house_number**). So "just declare NZ:1.0" would train on synthetic PO-box rows only → cosmetic coverage. NZ is a real shard build like CA/MX/BR, just with better source data. | **Yes** — NZ 2.12M OA/LINZ rows; CA/MX/BR OA extracts on disk. |
| **2 — Deepparse-trained, thin open data**                          | **KR, RU**                                                                     | Both gazetteered (KR is WOF-priority), both Deepparse-trained, but open _address_ data is thin. KR is flagged "no adopted open path" in `SCOPE.mdx:49` and routes through the deferred CJK/CharCNN path, not vocab splice. RU has limited OA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | No corpus; needs data acquisition.                             |
| **3 — Deepparse zero-shot only, EU/OA or Overture-buildings data** | **GR, LT, EE, LV, RO, BG, UA, RS, BA, IS, MD, BY, CY**                         | Deepparse itself only zero-shots these (lower parity bar). Gazetteered; most have OpenAddresses or Overture-buildings extracts, so a corpus shard is buildable with moderate effort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Partial — buildings/OA data usually available.                 |
| **4 — Deepparse zero-shot only, sparse open address data**         | **JP, IN, ID, PH, MY, SG, ZA, DZ, BD, KZ, UZ, AR, CO, VE, PY, RE, NC, BM, FO** | Gazetteered but little-to-no open address-level data; each needs new national-register acquisition. JP is a special case: resolver/tier-5 route already exists (`SCOPE.mdx:48`), parser deferred to the CJK CharCNN path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No — new data acquisition per country.                         |

---

## 4. Summary numbers

- **Deepparse OOTB countries:** 61 (20 trained + 41 zero-shot). No formal "zones".
- **mailwoman trained-model coverage of them:** 23.
- **mailwoman gazetteer/resolve coverage of them:** 61 (all).
- **Model gap (gazetteer-only):** 38 — the lowest-effort tier is a `locale`-recipe shard build:
  **NZ** (2.12M LINZ-derived OA street rows on disk — the best-provisioned), then **CA/MX/BR**
  (Deepparse-trained, OA extracts on disk). NZ is a real shard build, **not** a bare declare — the
  night-2 "8,967 rows, declare it" premise was falsified (see the CORRECTION in the rank table:
  the in-corpus 2,990 NZ rows are synth PO-box, no streets).

### Sources

- [Deepparse repo (GRAAL-Research/deepparse)](https://github.com/GRAAL-Research/deepparse)
- [Deepparse docs](https://deepparse.org/)
- [Yassine et al., arXiv:2006.16152](https://arxiv.org/abs/2006.16152)
- mailwoman: `corpus-python/src/mailwoman_train/configs/v3.10.1-span-ship-8k.yaml:32`,
`mailwoman/gazetteer-pipeline/defaults.ts:18,33,123`,
`docs/articles/plan/SCOPE.mdx:44-49`,
`corpus/src/shard-recipes/locale.ts:70`,
`docs/articles/evals/2026-07-16-night-postmortem.md:74-75,137-138`.
</content>

</invoke>
