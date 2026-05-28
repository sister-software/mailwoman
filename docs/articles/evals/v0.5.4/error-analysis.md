Loaded 4535 golden entries
Loading model...
Running eval...
500/4535 (2.5s)
1000/4535 (4.8s)
1500/4535 (7.1s)
2000/4535 (9.4s)
2500/4535 (11.7s)
3000/4535 (14.1s)
3500/4535 (16.4s)
4000/4535 (18.7s)
4500/4535 (21.1s)

# Error Analysis Report

**Golden set:** 4535 entries
**Model:** NeuralAddressClassifier
**Time:** 21.2s

## Summary

| Metric            | Count | Rate  |
| ----------------- | ----- | ----- |
| Exact match       | 771   | 17.0% |
| Missed entities   | 2684  | —     |
| Boundary errors   | 3698  | —     |
| Confused tags     | 1474  | —     |
| Hallucinated tags | 2381  | —     |

## Missed entities (2684)

- `6220 SE Salmon St, Portland, OR 97215, USA` — missing street_prefix="SE"
- `6220 SE Salmon St, Portland, OR 97215, USA` — missing street_suffix="St"
- `PO Box 123, Burlington, VT 05401` — missing po_box="PO Box 123"
- `123 Main St Apt 4B, Springfield, IL 62701` — missing unit="Apt 4B"
- `Main St & 5th Ave, Portland, OR` — missing intersection_a="Main St"

## Boundary errors (3698)

- `6220 SE Salmon St, Portland, OR 97215, USA` — street: expected "Salmon" got "SE Salmon St"
- `Main St & 5th Ave, Portland, OR` — region: expected "OR" got "Portland"
- `500 W 7th St Ste 1100, Cincinnati, OH 45203-1234` — street: expected "7th" got "W 7th St Ste 1100"
- `123 main st portland or 97214` — street: expected "main st" got "main"
- `CULLEN INSULATION INC, POBOX 3211 FARGO ND 58108, FARGO, ND 58108` — venue: expected "CULLEN INSULATION INC" got "CULLEN"

## Confused tags (1474)

- `Vermont, USA` — region: expected "Vermont" got "USA"
- `05770 VT DELONG LN` — street: expected "DELONG LN" got "VT"
- `ND 58368 6th St SW` — street: expected "6th St SW" got "ND"
- `ND 58701 Airview Dr` — street: expected "Airview Dr" got "ND"
- `WY 82601 Mountain Way` — street: expected "Mountain Way" got "WY"

## Hallucinated tags (2381)

- `PO Box 123, Burlington, VT 05401` — hallucinated street="PO Box 123"
- `Main St & 5th Ave, Portland, OR` — hallucinated dependent_locality="Main St"
- `12345 Mt Tabor Park, Portland, OR 97215` — hallucinated street="Mt Tabor Park"
- `Vermont, USA` — hallucinated dependent_locality="Vermont"
- `05764 Finel Hollow Road, VT` — hallucinated house_number="0576"
