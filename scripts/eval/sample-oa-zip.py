#!/usr/bin/env python3
"""Reservoir-sample an OpenAddresses national CSV (inside a ZIP64 zip) into a resolver-eval JSONL.

The ingest-openaddresses.mjs path uses `unzip -p`, which chokes on ZIP64 (national datasets like FR
BAN have a >4GB CSV). Python's zipfile streams ZIP64 fine. Same output shape as the other
openaddresses-*-sample.jsonl files: {input, lat, lon, expected:{locality,region,postcode}, state, source}.

Usage:
  python3 scripts/eval/sample-oa-zip.py --zip /tmp/oa-cache/fr__countrywide.zip --country FR \
    --target 3000 --seed 42 --out data/eval/external/openaddresses-fr-sample.jsonl
"""
import argparse, csv, io, json, random, zipfile

BBOX = {
    "FR": (41.0, 51.5, -5.5, 9.7),
    "NL": (50.7, 53.6, 3.3, 7.3),
    "IT": (35.0, 47.2, 6.5, 18.6),
    "ES": (27.5, 43.9, -18.3, 4.4),  # mainland + Balearics + Canaries
}
# Normalize a raw CSV row to the OA-standard column names. Most national OA exports already use
# NUMBER/STREET/CITY/POSTCODE/REGION/LAT/LON; Spain ships the CartoCiudad schema (X/Y, nombre_via,
# poblacion, provincia, …) so we remap it. STREET folds in the Spanish street-type (CALLE/AVENIDA).
def normalize_row(country, r):
    if country == "ES":
        via = f"{(r.get('tipo_vial') or '').strip()} {(r.get('nombre_via') or '').strip()}".strip()
        return {"LAT": r.get("Y"), "LON": r.get("X"), "NUMBER": (r.get("numero") or "").strip(),
                "STREET": via, "CITY": (r.get("poblacion") or "").strip(),
                "POSTCODE": (r.get("cod_postal") or "").strip(), "REGION": (r.get("provincia") or "").strip()}
    return r

# Render order per locale (the raw string the parser sees).
def render(country, r):
    num, street, pc, city = r["NUMBER"].strip(), r["STREET"].strip(), r["POSTCODE"].strip(), r["CITY"].strip()
    if country == "FR":  # "12 Rue de Rivoli, 75001 Paris"
        return f"{num} {street}, {pc} {city}".strip(", ")
    if country in ("NL", "IT", "ES"):  # number after street: "Via Roma 12, 20121 Milano" / "Calle de Alcalá 1, 28014 Madrid"
        return f"{street} {num}, {pc} {city}".strip(", ")
    return f"{num} {street}, {pc} {city}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--country", required=True)
    ap.add_argument("--target", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    minlat, maxlat, minlon, maxlon = BBOX[args.country]

    z = zipfile.ZipFile(args.zip)
    csv_name = [n for n in z.namelist() if n.endswith(".csv")][0]
    reservoir, seen = [], 0
    with z.open(csv_name) as raw:
        reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
        for raw_row in reader:
            r = normalize_row(args.country, raw_row)
            try:
                lat, lon = float(r["LAT"]), float(r["LON"])
            except (ValueError, KeyError, TypeError):
                continue
            if not (minlat <= lat <= maxlat and minlon <= lon <= maxlon):
                continue
            city, pc = (r.get("CITY") or "").strip(), (r.get("POSTCODE") or "").strip()
            if not city or not pc:
                continue  # admin-level eval needs city + postcode
            seen += 1
            row = {
                "input": render(args.country, r),
                "lat": lat, "lon": lon,
                "expected": {"locality": city, "region": (r.get("REGION") or "").strip() or None, "postcode": pc},
                "state": args.country,
                "source": f"openaddresses:{args.country.lower()}/countrywide",
            }
            if len(reservoir) < args.target:
                reservoir.append(row)
            else:
                j = rng.randint(0, seen - 1)
                if j < args.target:
                    reservoir[j] = row
    with open(args.out, "w", encoding="utf-8") as f:
        for row in reservoir:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"wrote {len(reservoir)} rows (sampled from {seen:,} valid in-bbox) → {args.out}")

if __name__ == "__main__":
    main()
