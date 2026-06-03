# Postcode anchor through the resolver eval (2026-06-03)

The postcode anchor (#240) is now wired into the OpenAddresses real-point resolver eval as a
`neural+anchor` row (`--postcode-anchor`). The neural parse and the resolver supply the admin/place
identity as before; the **coordinate** is taken from the postcode anchor's own centroid. So the row
isolates exactly what the anchor sharpens: where, not which place. The tables below are emitted verbatim
by `scripts/eval/oa-resolver-eval.ts` (eval figures are never hand-typed).

The result splits by one thing: whether the resolver's shards already carry the locale's postcodes.

## German — the resolver has admin only, no German postcodes

```
| parser | locality-match | region-match | resolved | coord p50 km | coord p90 km | p99 km |
| **neural** | 77.4% | 0.1% | 99.3% | 9.9 | 66.8 | 318.2 |
| v0 (Pelias) | 79.3% | 50.0% | 99.3% | 7.0 | 16.9 | 106.8 |
| **neural+anchor** | 77.4% | 0.1% | 99.3% | 1.2 | 5.1 | 10.9 |
```

The anchor drops coord p50 from 9.9 km to **1.2 km** (p90 66.8 → 5.1, p99 318 → 10.9), with the
admin-match rate unchanged. The German parser is out of distribution (locality 77%, region near zero), so
the resolver lands on a coarse admin centroid; the postcode anchor, a regex plus a gazetteer with no
model in the loop, carries the coordinate to the postcode's own point. It also beats the Pelias parser
(v0) on coordinate by a wide margin (1.2 vs 7.0 km).

## US — the resolver already loads `postalcode-us.db`

```
| parser | locality-match | region-match | resolved | coord p50 km | coord p90 km | p99 km |
| **neural** | 97.3% | 99.9% | 100.0% | 2.5 | 11.2 | 25.7 |
| v0 (Pelias) | 95.3% | 99.4% | 99.7% | 2.5 | 11.2 | 25.7 |
| **neural+anchor** | 97.3% | 99.9% | 100.0% | 2.5 | 11.2 | 25.7 |
```

Here `neural+anchor` is identical to `neural`. The US resolver already resolves ZIPs to their centroids
(`postalcode-us.db` is one of its shards), so the anchor supplies the same coordinate and neither helps
nor harms. (Getting to this no-harm result took two fixes, both worth recording: never borrow another
country's centroid for a coordless US ZIP, and pick the **last** postcode-shaped span, since the real
postcode trails the locality while an earlier 5-digit is a house number that merely shares a ZIP's shape.)

## Takeaway

The fusion's value is the gap it fills: postcode-level coordinates for the locales whose postcodes the
resolver's shards do not carry (DE/ES/IT/NL/FR), and a no-op where they do (US). It is the postcode tier
the eval's own note promised, sitting between the admin-centroid tier and the future street-level (TIGER)
tier. Span selection here uses the last postcode-shaped span as the position heuristic; encoding position
into the anchor's own confidence is the production refinement that would let it run without that crutch.

Reproduce:

```bash
node --experimental-strip-types scripts/eval/oa-resolver-eval.ts \
  --eval data/eval/external/openaddresses-de-sample.jsonl --limit 1500 --default-country DE \
  --model <onnx> --tokenizer <tok> --model-card <card> \
  --wof /mnt/playpen/mailwoman-data/wof/admin-global-priority.db \
  --postcode-anchor
```
