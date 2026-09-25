# Deepparse OOTB locale coverage — the mailwoman gap list

**Date:** 2026-07-18
**Task:** List every locale and country that Deepparse's pretrained models support out of the box, compare
the list with mailwoman's current coverage, and rank the gaps by effort. Mailwoman's parser-model coverage
and its gazetteer/resolve coverage differ, so the comparison covers each separately.

Every claim below cites a source: a URL for Deepparse, a `file:line` for mailwoman.

---

## 1. Deepparse OOTB country coverage

Deepparse ships two pretrained models (fastText, BPEmb) trained on a subset of the
libpostal-derived SubwayGroup _structured multinational address_ dataset (Yassine et al.,
["Leveraging Subword Embeddings for Multinational Address Parsing", arXiv:2006.16152](https://arxiv.org/abs/2006.16152)).
The dataset spans **61 countries**, split into a **20-country training set** and a **41-country
zero-shot test set**. Deepparse has no formal "zones". Its only grouping
is trained vs zero-shot.

- Coverage list (train + zero-shot): [Deepparse README, GRAAL-Research/deepparse](https://github.com/GRAAL-Research/deepparse)
  (fetched 2026-07-18) and the [dataset docs](https://deepparse.org/).
- Both pretrained models parse all 61 countries, and accuracy is _reported_ on all 61. Only the 20 training
  countries carry a supervised signal. The other 41 measure zero-shot generalization.

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
`corpus-python/src/mailwoman_train/configs/v3.10.1-span-ship-8k.yaml:32`) gives supervised
exposure to these countries:

> US, FR, DE, ES, IT, NL, PT, BE, PL, AT, CH, CZ, DK, NO, SE, FI, IE, GB, SK, SI, HR, HU, AU

AU is trained through the `gnaf` source (weight 6.0) in the same block. `docs/articles/plan/SCOPE.mdx:44-48`
assigns these claims to tiers that say which are floor-conditional and which are thinly measured:
Tier 1 US/FR (floor-conditional), Tier 2 IT/PT/PL/AT/CZ/DE/AU/BE/ES/NL/CH/HR/DK/FI (coordinate-paneled),
Tier 3 NO/SE (thin), Tier 4 CZ/PL/SK/SI (diacritic splice), and Tier 5 JP (resolver route only, with **no
parser training claim**).

### (b) Gazetteer / resolve coverage — much broader

The admin-gazetteer recipe (`mailwoman/gazetteer-pipeline/defaults.ts`) takes the union of three tiers:

- `DEFAULT_WOF_PRIORITY_COUNTRIES` (`defaults.ts:18`): CN, DE, ES, FR, GB, IT, **JP, KR**, NL, TW, US.
- `DEFAULT_OVERTURE_COUNTRIES` (`defaults.ts:33`): 86 countries, including **AU, BR, CA, MX, NZ, RU** and
  most of the EU / LATAM / MENA / APAC.
- `DEFAULT_GEONAMES_COUNTRIES` (`defaults.ts:123`): a 161-country alias-fold tail, including **BM, BA, CY,
  FO, MD, NC, PY, RE, UZ**.

**All 61 Deepparse OOTB countries have gazetteer/resolve coverage in mailwoman.** The whole gap
is on the _parser-model_ side.

---

## 3. The gap

Of Deepparse's 61 OOTB countries, mailwoman has:

- **Trained parser-model coverage: 23** (all 23 of mailwoman's trained countries fall inside
  Deepparse's 61).
- **Gazetteer/resolve coverage: 61** (all of them).
- **Model gap (gazetteer only, without parser training): 38**. These are 5 of Deepparse's _trained_ 20 and 33 of
  its zero-shot 41.

Every gap country already resolves. Adding one means building a corpus extract, adding it to
`country_weights`, retraining, and setting up a coordinate-graded eval. The effort therefore depends on
**whether address-level training data already exists** rather than on gazetteer work.

### Ranked by effort

| Rank                                                               | Countries                                                                      | Why this effort                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Data in hand?                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **1 — Deepparse parity gaps, OA/LINZ street data on disk**         | **NZ, CA, MX, BR**                                                             | Each of the four needs a `locale`-recipe extract build (`corpus/src/extract-recipes/locale.ts` `COUNTRY_SOURCES`): extend the map, build a street extract, add it to `country_weights`, retrain, and coord-grade. **NZ** has the best source data: `openaddresses/extracted/nz/countrywide.csv` holds **2.12M** LINZ-derived street rows (verified 2026-07-18), and the formatter already renders NZ correctly. CA has dense OA coverage, and MX/BR have partial coverage. **Correction (2026-07-18):** the night-2 postmortem ranked NZ 0 ("declare + retrain, 8,967 rows on disk"), and the following census **disproves** that premise. A full census of all 685 v0.5.0 base extracts (676M rows) finds **2,990** NZ rows instead of 8,967. The 8,967 figure came from reading only the first 300k rows in `country_census_raw`'s ordering. **All 2,990 rows are `synth-po-box-cedex`** (po_box/locality/postcode/venue, with **zero street/house_number**). Declaring NZ:1.0 would therefore train only on synthetic PO-box rows and add coverage in name only. NZ needs a real extract build like CA/MX/BR, with better source data. | **Yes** — NZ 2.12M OA/LINZ rows; CA/MX/BR OA extracts on disk. |
| **2 — Deepparse-trained, thin open data**                          | **KR, RU**                                                                     | Both are gazetteered (KR is WOF-priority) and Deepparse-trained, but open _address_ data is thin. `SCOPE.mdx:49` flags KR as "no adopted open path", and KR routes through the deferred CJK/CharCNN path instead of vocab splice. RU has limited OA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No corpus; needs data acquisition.                             |
| **3 — Deepparse zero-shot only, EU/OA or Overture-buildings data** | **GR, LT, EE, LV, RO, BG, UA, RS, BA, IS, MD, BY, CY**                         | Deepparse itself only zero-shots these, so the parity bar is lower. All are gazetteered, and most have OpenAddresses or Overture-buildings extracts, so a corpus extract takes moderate effort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Partial — buildings/OA data typically available.               |
| **4 — Deepparse zero-shot only, sparse open address data**         | **JP, IN, ID, PH, MY, SG, ZA, DZ, BD, KZ, UZ, AR, CO, VE, PY, RE, NC, BM, FO** | These are gazetteered but have little or no open address-level data. Each needs a new national-register acquisition. JP is a special case: the resolver/tier-5 route already exists (`SCOPE.mdx:48`), and parser work is deferred to the CJK CharCNN path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | No — new data acquisition per country.                         |

---

## 4. Summary numbers

- **Deepparse OOTB countries:** 61 (20 trained + 41 zero-shot). No formal "zones".
- **mailwoman trained-model coverage of them:** 23.
- **mailwoman gazetteer/resolve coverage of them:** 61 (all).
- **Model gap (gazetteer only):** 38. The lowest-effort tier is a `locale`-recipe extract build.
  **NZ** comes first, with 2.12M LINZ-derived OA street rows on disk, followed by **CA/MX/BR**
  (Deepparse-trained, with OA extracts on disk). NZ needs a real extract build, and a declaration alone would add no street data. The
  night-2 premise of "8,967 rows, declare it" was wrong. The correction in the rank table shows that
  the 2,990 NZ rows in the corpus are synthetic PO-box rows without streets.

### Sources

- [Deepparse repo (GRAAL-Research/deepparse)](https://github.com/GRAAL-Research/deepparse)
- [Deepparse docs](https://deepparse.org/)
- [Yassine et al., arXiv:2006.16152](https://arxiv.org/abs/2006.16152)
- mailwoman: `corpus-python/src/mailwoman_train/configs/v3.10.1-span-ship-8k.yaml:32`,
  `mailwoman/gazetteer-pipeline/defaults.ts:18,33,123`,
  `docs/articles/plan/SCOPE.mdx:44-49`,
  `corpus/src/extract-recipes/locale.ts:70`,
  `docs/articles/evals/2026-07-16-night-postmortem.md:74-75,137-138`.
