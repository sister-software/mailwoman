#!/usr/bin/env python3
"""A/B the postcode-anchor country posterior: UNIFORM vs frequency-weighted, decided on held-out real
collisions (#240, measure-before-you-build for the uniform-vs-de-biased question).

The shipped anchor (`neural/postcode-anchor.ts`) uses a UNIFORM posterior: 1/k over the countries a
postcode exists in. An earlier DeepSeek consult chose uniform to dodge the bias of raw-count weighting.
A later consult argued for a DE-BIASED Bayesian posterior. They disagree, so we measure it instead of
arguing.

The true posterior is P(country | postcode) ∝ N_c(x) — the real address-count ratio. We can't observe
N_c(x) directly, but we can estimate it and check which posterior predicts the true country of a
held-out real address whose postcode collides across countries.

Canonical testbed: US ↔ FR 5-digit collisions (75001 is both central Paris and Addison, TX). It is the
collision case AND the one where we have rich frequency data on both sides.

  - f̂ source (TRAIN):  corpus v0.1.0 (4.4M real addresses; US ~2.3M, FR ~2.1M) — count(country, postcode).
  - candidate set:      US ∩ FR 5-digit postcodes (the postal-DB membership the runtime extractor sees).
  - test (HELD-OUT):    data/eval/external/openaddresses-{us,fr}-sample.jsonl — a DIFFERENT extraction,
                        so f̂ is never graded on the data it was fit to.

Three posteriors over the candidate set {US, FR}:
  A. uniform          p_c = 1/k
  B. naive-count      p_c ∝ count(c, x)                          (raw counts — the bias the earlier consult feared)
  C. de-biased        p_c ∝ f̂_c(x) · prior(c),  f̂_c(x)=(count+α)/(total+α),  prior=address-volume

Metrics on held-out collision addresses, reported PER TRUE COUNTRY and BALANCED (so a country-skewed
prior can't win by exploiting the 10k-US-vs-3k-FR test imbalance): log-loss, top-1 accuracy, and the
high-confidence error rate (p_argmax > 0.8 but wrong — the failure mode that hurts the resolver re-rank).

Usage:  python3 scripts/eval/postcode-posterior-ab.py
"""
import collections
import glob
import json
import math

import pyarrow.parquet as pq

V010 = "/mnt/playpen/mailwoman-data/corpus/versioned/v0.1.0/corpus-v0.1.0/train"
US_DB = "/mnt/playpen/mailwoman-data/wof/postalcode-us.db"
INTL_DB = "/mnt/playpen/mailwoman-data/wof/postalcode-intl.db"
OA = "data/eval/external/openaddresses-{}-sample.jsonl"

# Real-world address-volume prior (order-of-magnitude; postal-union / census figures). Only the RATIO
# matters, and only across the candidate set.
ADDR_VOLUME = {"US": 160e6, "FR": 35e6}
ALPHA = 0.5  # add-α smoothing for f̂


def five_digit(pc: str) -> str | None:
	pc = (pc or "").strip()
	return pc if len(pc) == 5 and pc.isdigit() else None


def collision_set() -> set[str]:
	import sqlite3

	us = {r[0] for r in sqlite3.connect(US_DB).execute("SELECT name FROM spr WHERE placetype='postalcode'")}
	fr = {
		r[0]
		for r in sqlite3.connect(INTL_DB).execute(
			"SELECT name FROM spr WHERE placetype='postalcode' AND country='FR'"
		)
	}
	us5 = {p for p in us if five_digit(p)}
	fr5 = {p for p in fr if five_digit(p)}
	return us5 & fr5


def build_fhat() -> tuple[dict, dict]:
	"""count[(country, postcode)] and total[country] over v0.1.0 real addresses (US/FR, 5-digit)."""
	count: dict[tuple[str, str], int] = collections.defaultdict(int)
	total: dict[str, int] = collections.defaultdict(int)
	for shard in sorted(glob.glob(f"{V010}/*.parquet")):
		pf = pq.ParquetFile(shard)
		for batch in pf.iter_batches(columns=["tokens", "labels", "country"], batch_size=50000):
			d = batch.to_pydict()
			for toks, labs, ctry in zip(d["tokens"], d["labels"], d["country"]):
				if ctry not in ("US", "FR"):
					continue
				parts = [t for t, l in zip(toks, labs) if l in ("B-postcode", "I-postcode")]
				pc = five_digit("".join(parts))
				if pc:
					count[(ctry, pc)] += 1
					total[ctry] += 1
	return count, total


def posteriors(pc: str, count: dict, total: dict) -> dict[str, dict[str, float]]:
	cands = ["US", "FR"]
	out = {}
	# A. uniform
	out["uniform"] = {c: 0.5 for c in cands}
	# B. naive count-weighted
	raw = {c: count.get((c, pc), 0) + ALPHA for c in cands}
	z = sum(raw.values())
	out["naive_count"] = {c: raw[c] / z for c in cands}
	# C. de-biased: f̂ · prior
	prior_z = sum(ADDR_VOLUME[c] for c in cands)
	deb = {}
	for c in cands:
		fhat = (count.get((c, pc), 0) + ALPHA) / (total[c] + ALPHA)
		deb[c] = fhat * (ADDR_VOLUME[c] / prior_z)
	z = sum(deb.values())
	out["de_biased"] = {c: deb[c] / z for c in cands}
	return out


def load_test(coll: set[str]) -> list[tuple[str, str]]:
	"""(postcode, true_country) for held-out OA addresses whose postcode is a collision."""
	rows = []
	for cc, country in (("us", "US"), ("fr", "FR")):
		with open(OA.format(cc), encoding="utf-8") as fh:
			for line in fh:
				try:
					pc = five_digit(json.loads(line).get("expected", {}).get("postcode", ""))
				except json.JSONDecodeError:
					continue
				if pc and pc in coll:
					rows.append((pc, country))
	return rows


def main() -> None:
	print("building collision set + f̂ (this reads v0.1.0, ~30s)…")
	coll = collision_set()
	count, total = build_fhat()
	print(f"  collisions(US∩FR 5-digit): {len(coll):,}   f̂ totals: US={total['US']:,} FR={total['FR']:,}")

	test = load_test(coll)
	by_country = collections.Counter(c for _, c in test)
	print(f"  held-out collision test addresses: {len(test):,}  (US={by_country['US']:,}, FR={by_country['FR']:,})\n")

	methods = ["uniform", "naive_count", "de_biased"]
	# per (method, true_country): [logloss_sum, n, top1, highconf_err]
	agg = {m: {c: [0.0, 0, 0, 0] for c in ("US", "FR")} for m in methods}
	for pc, truth in test:
		post = posteriors(pc, count, total)
		for m in methods:
			p = post[m]
			a = agg[m][truth]
			a[0] += -math.log(max(p[truth], 1e-12))
			a[1] += 1
			arg = max(p, key=p.get)
			if arg == truth:
				a[2] += 1
			elif p[arg] > 0.8:
				a[3] += 1

	def line(label: str, ll: float, n: int, t1: int, hce: int) -> str:
		return f"    {label:<8} logloss={ll / max(n,1):.4f}  top1={100*t1/max(n,1):5.1f}%  highconf-err={100*hce/max(n,1):4.1f}%  (n={n})"

	print("=" * 78)
	for m in methods:
		us, fr = agg[m]["US"], agg[m]["FR"]
		bal_ll = 0.5 * (us[0] / max(us[1], 1) + fr[0] / max(fr[1], 1))
		bal_t1 = 0.5 * (us[2] / max(us[1], 1) + fr[2] / max(fr[1], 1))
		print(f"\n[{m}]")
		print(line("true=US", *us))
		print(line("true=FR", *fr))
		print(f"    BALANCED logloss={bal_ll:.4f}  top1={100*bal_t1:.1f}%   <-- the fair number")
	print("\n" + "=" * 78)
	print("Lower balanced logloss = better-calibrated posterior. Higher balanced top1 = picks the right")
	print("country more often on genuine collisions. de_biased should beat uniform; naive_count is the")
	print("control showing why raw counts were feared.")


if __name__ == "__main__":
	main()
