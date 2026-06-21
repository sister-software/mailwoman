# The "within-token punctuation" weakness is a misnomer (#375 follow-up)

The failure taxonomy flagged within-token punctuation as the clearest open neural weakness — apostrophe
81% vs v0 89%, hyphen 81 vs 87, slash 62 vs 72 (`2026-06-14-punctuation-stress`) — with the root cause
"unmeasured." Measured now (`scripts/eval/within-token-punct-diag.ts`, neural's actual parse vs gold on
the 61 apostrophe/hyphen/slash rows): **the punctuation token itself rarely fails.** The gap decomposes
into four distinct mechanisms, three of which are already top-priority levers under other names.

## What actually fails

| class      | rows with ≥1 miss | dominant missed components                       |
| ---------- | ----------------: | ------------------------------------------------ |
| apostrophe |              7/16 | locality 3, region 3, street 3                   |
| hyphen     |             13/23 | street 9, house_number 6, locality 5             |
| slash      |             17/22 | house_number 12, locality 10, region 10, unit 10 |

The apostrophe **parses correctly** — `O'Connell`, `O'Fallon`, `Coeur d'Alene`, `Martha's Vineyard` all
land in the right component. The misses in those rows are elsewhere in the address.

## The four real mechanisms

1. **The AU/UK slash unit-convention (the one new, addressable gap).** `4/2A Princes St` is
   unit 4 + number 2A; `Penthouse 1/2 Pacific Hwy` is unit "Penthouse 1" + number 2. Neural keeps the
   `X/Y` glued as one `house_number` and never splits it. This is the bulk of the slash class's 62% and
   is a specific, learnable convention (slash between unit and street-number in AU/NZ/UK).

2. **Comma-less `City STATE` segmentation — the #694 family.** `North Sydney NSW 2060`, `Sydney NSW
2000`: with no comma, neural keeps `North Sydney NSW` as one locality and drops the region. This is
   the same delimiter-stripping failure root-caused on #694 (concatenated input loses segmentation) —
   delimited input fixes it.

3. **Street/affix boundary wobble — the taxonomy's #1 parser lever.** `Country Club Rd` keeps `Rd` in
   the street (no `street_suffix`); FR `Rue Jean-Baptiste Lebas` / `Rue Neuve-des-Capucines 5` drop the
   `Rue` prefix and absorb the house number into the street. Pure boundary instability — nothing to do
   with the hyphen.

4. **OOD-token leading-char drop — the #690 family.** `N9W16851` (a Wisconsin grid address) parses to
   house_number `9W16851` — the leading `N` is dropped, exactly the artifact behind all-caps
   `PALESTINE`→`ALESTINE` (#690). Plus genuine foreign-postcode-format gaps: Irish `V94 DPF3` splits to
   locality `Limerick V` + postcode `94`; hyphenated ranges (`55-57`) mis-split.

## Why it matters

The within-token punctuation gap is **not a punctuation-tokenizer problem** and does not warrant a
punctuation-specific fix. It decomposes into:

- the **#694 comma-less/delimiter** lever (fixing concatenated-input segmentation — already validated),
- the **#1 boundary-instability** lever (street/affix; the taxonomy's highest-leverage parser fix),
- the **#690 OOD-token** family (leading-char drops; foreign postcode formats),
- and **one new specific case**: the AU/UK slash unit-convention (`4/2A`).

So three of the four are closed by levers already prioritized — fixing boundary instability + delimited
input would lift the apostrophe/hyphen classes without touching punctuation. The slash class needs the
AU/UK unit-convention specifically (a training-shard or a decode rule for `digit/alnum` between a unit
designator and a street number). **Taxonomy update: re-label the "within-token punctuation" row as a
symptom of the boundary-instability + #694 + #690 families, plus the AU/UK slash convention.**

_Source: `scripts/eval/within-token-punct-diag.ts` over the apostrophe/hyphen/slash rows of
`data/eval/external/punctuation-stress.jsonl`._
