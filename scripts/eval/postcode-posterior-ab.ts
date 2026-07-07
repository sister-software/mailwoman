/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A/B the postcode-anchor country posterior: UNIFORM vs frequency-weighted, decided on held-out
 *   real collisions (#240, measure-before-you-build for the uniform-vs-de-biased question).
 *
 *   The shipped anchor (`neural/postcode-anchor.ts`) uses a UNIFORM posterior: 1/k over the countries
 *   a postcode exists in. An earlier DeepSeek consult chose uniform to dodge the bias of raw-count
 *   weighting. A later consult argued for a DE-BIASED Bayesian posterior. They disagree, so we
 *   measure it instead of arguing.
 *
 *   The true posterior is P(country | postcode) ∝ N_c(x) — the real address-count ratio. We can't
 *   observe N_c(x) directly, but we can estimate it and check which posterior predicts the true
 *   country of a held-out real address whose postcode collides across countries.
 *
 *   Canonical testbed: US ↔ FR 5-digit collisions (75001 is both central Paris and Addison, TX).
 *
 *   Ported faithfully from scripts/eval/postcode-posterior-ab.py. Parquet reads go through DuckDB
 *   (`@duckdb/node-api`); the WOF SQLite reads use `node:sqlite`.
 *
 *   Usage: node --experimental-strip-types scripts/eval/postcode-posterior-ab.ts
 */

import { globSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DuckDBInstance } from "@duckdb/node-api"

const V010 = "/mnt/playpen/mailwoman-data/corpus/versioned/v0.1.0/corpus-v0.1.0/train"
const US_DB = "/mnt/playpen/mailwoman-data/wof/postalcode-us.db"
const INTL_DB = "/mnt/playpen/mailwoman-data/wof/postalcode-intl.db"
const OA = (cc: string) => `data/eval/external/openaddresses-${cc}-sample.jsonl`

// Real-world address-volume prior (order-of-magnitude; postal-union / census figures). Only the RATIO
// matters, and only across the candidate set.
const ADDR_VOLUME: Record<string, number> = { US: 160e6, FR: 35e6 }
const ALPHA = 0.5 // add-α smoothing for f̂

function fiveDigit(pc: string | null | undefined): string | null {
	const s = (pc || "").trim()

	return s.length === 5 && /^[0-9]+$/.test(s) ? s : null
}

/** Coerce a DuckDB list column (a `DuckDBListValue` with `.items`, or a plain array) to `string[]`. */
function toStringArray(value: unknown): string[] {
	if (value == null) return []

	if (Array.isArray(value)) return value.map((v) => String(v))
	const items = (value as { items?: unknown[] }).items

	if (Array.isArray(items)) return items.map((v) => String(v))

	return []
}

/** Group an integer with thousands separators — Python `f"{n:,}"`. */
function pyComma(n: number): string {
	return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Python `format(x, ".{d}f")` — round-half-to-even (banker's), unlike JS `toFixed` (half-away). */
function pyFixed(x: number, d: number): string {
	if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf"
	const neg = x < 0 || Object.is(x, -0)
	const [intPart, fracRaw = ""] = Math.abs(x).toFixed(20).split(".")
	const frac = fracRaw

	if (frac.length <= d) {
		const body = d > 0 ? `${intPart}.${frac.padEnd(d, "0")}` : intPart!

		return (neg ? "-" : "") + body
	}
	const keep = frac.slice(0, d)
	const rest = frac.slice(d)
	let roundUp: boolean

	if (rest[0]! > "5") {
		roundUp = true
	} else if (rest[0]! < "5") {
		roundUp = false
	} else if (rest.slice(1).replace(/0+$/, "").length > 0) {
		roundUp = true
	} else {
		const lastKept = d > 0 ? (keep[d - 1] ?? "0") : (intPart![intPart!.length - 1] ?? "0")
		roundUp = parseInt(lastKept, 10) % 2 === 1
	}
	let digits = intPart! + keep

	if (roundUp) {
		const arr = digits.split("")
		let i = arr.length - 1

		for (; i >= 0; i--) {
			if (arr[i] === "9") {
				arr[i] = "0"
			} else {
				arr[i] = String(parseInt(arr[i]!, 10) + 1)
				break
			}
		}

		if (i < 0) {
			arr.unshift("1")
		}
		digits = arr.join("")
	}
	const di = digits.length - d
	const body = d > 0 ? `${digits.slice(0, di) || "0"}.${digits.slice(di)}` : digits.slice(0, di) || "0"

	return (neg ? "-" : "") + body
}

function collisionSet(): Set<string> {
	const us = new Set<string>()
	const usDB = new DatabaseSync(US_DB, { readOnly: true })

	for (const r of usDB.prepare("SELECT name FROM spr WHERE placetype='postalcode'").iterate()) {
		us.add((r as { name: string }).name)
	}
	usDB.close()
	const fr = new Set<string>()
	const intlDB = new DatabaseSync(INTL_DB, { readOnly: true })

	for (const r of intlDB.prepare("SELECT name FROM spr WHERE placetype='postalcode' AND country='FR'").iterate()) {
		fr.add((r as { name: string }).name)
	}
	intlDB.close()
	const us5 = new Set<string>([...us].filter((p) => fiveDigit(p)))
	const fr5 = new Set<string>([...fr].filter((p) => fiveDigit(p)))

	return new Set<string>([...us5].filter((p) => fr5.has(p)))
}

interface FHat {
	count: Map<string, Map<string, number>> // count[country][postcode]
	total: Map<string, number>
}

function countGet(count: Map<string, Map<string, number>>, ctry: string, pc: string): number {
	return count.get(ctry)?.get(pc) ?? 0
}

/** Count[(country, postcode)] and total[country] over v0.1.0 real addresses (US/FR, 5-digit). */
async function buildFhat(): Promise<FHat> {
	const count = new Map<string, Map<string, number>>([
		["US", new Map()],
		["FR", new Map()],
	])
	const total = new Map<string, number>()
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()

	for (const shard of globSync(`${V010}/*.parquet`).sort()) {
		const escaped = shard.replace(/'/g, "''")
		const result = await db.runAndReadAll(`SELECT tokens, labels, country FROM read_parquet('${escaped}')`)
		const rows = result.getRowObjects() as Array<Record<string, unknown>>

		for (const row of rows) {
			const ctry = row.country as string

			if (ctry !== "US" && ctry !== "FR") continue
			const toks = toStringArray(row.tokens)
			const labs = toStringArray(row.labels)
			const parts: string[] = []
			const m = Math.min(toks.length, labs.length)

			for (let i = 0; i < m; i++) {
				if (labs[i] === "B-postcode" || labs[i] === "I-postcode") {
					parts.push(toks[i]!)
				}
			}
			const pc = fiveDigit(parts.join(""))

			if (pc) {
				const cm = count.get(ctry)!
				cm.set(pc, (cm.get(pc) ?? 0) + 1)
				total.set(ctry, (total.get(ctry) ?? 0) + 1)
			}
		}
	}

	return { count, total }
}

type Posterior = Record<string, number>

function posteriors(
	pc: string,
	count: Map<string, Map<string, number>>,
	total: Map<string, number>
): Record<string, Posterior> {
	const cands = ["US", "FR"]
	const out: Record<string, Posterior> = {}
	// A. uniform
	out.uniform = { US: 0.5, FR: 0.5 }
	// B. naive count-weighted
	const raw: Posterior = {}

	for (const c of cands) {
		raw[c] = countGet(count, c, pc) + ALPHA
	}
	let z = cands.reduce((s, c) => s + raw[c]!, 0)
	out.naive_count = {}

	for (const c of cands) {
		out.naive_count[c] = raw[c]! / z
	}
	// C. de-biased: f̂ · prior
	const priorZ = cands.reduce((s, c) => s + ADDR_VOLUME[c]!, 0)
	const deb: Posterior = {}

	for (const c of cands) {
		const fhat = (countGet(count, c, pc) + ALPHA) / ((total.get(c) ?? 0) + ALPHA)
		deb[c] = fhat * (ADDR_VOLUME[c]! / priorZ)
	}
	z = cands.reduce((s, c) => s + deb[c]!, 0)
	out.de_biased = {}

	for (const c of cands) {
		out.de_biased[c] = deb[c]! / z
	}

	return out
}

/** (postcode, true_country) for held-out OA addresses whose postcode is a collision. */
function loadTest(coll: Set<string>): Array<[string, string]> {
	const rows: Array<[string, string]> = []

	for (const [cc, country] of [
		["us", "US"],
		["fr", "FR"],
	] as Array<[string, string]>) {
		const text = readFileSync(OA(cc), "utf-8")

		for (const line of text.split("\n")) {
			if (!line) continue
			let pc: string | null

			try {
				pc = fiveDigit(JSON.parse(line).expected?.postcode ?? "")
			} catch {
				continue
			}

			if (pc && coll.has(pc)) {
				rows.push([pc, country])
			}
		}
	}

	return rows
}

/** Python `max(p, key=p.get)` over the candidate set: first key with the strictly-greatest value. */
function argmax(p: Posterior, cands: string[]): string {
	let best = cands[0]!

	for (const c of cands)
		if (p[c]! > p[best]!) {
			best = c
		}

	return best
}

function padR(s: string, w: number): string {
	return s.padStart(w)
}

function padL(s: string, w: number): string {
	return s.padEnd(w)
}

async function main(): Promise<void> {
	console.log("building collision set + f̂ (this reads v0.1.0, ~30s)…")
	const coll = collisionSet()
	const { count, total } = await buildFhat()
	console.log(
		`  collisions(US∩FR 5-digit): ${pyComma(coll.size)}   f̂ totals: US=${pyComma(total.get("US") ?? 0)} FR=${pyComma(total.get("FR") ?? 0)}`
	)

	const test = loadTest(coll)
	const byCountry: Record<string, number> = { US: 0, FR: 0 }

	for (const [, c] of test) {
		byCountry[c] = (byCountry[c] ?? 0) + 1
	}
	console.log(
		`  held-out collision test addresses: ${pyComma(test.length)}  (US=${pyComma(byCountry.US!)}, FR=${pyComma(byCountry.FR!)})\n`
	)

	const methods = ["uniform", "naive_count", "de_biased"]
	const cands = ["US", "FR"]
	// per (method, true_country): [logloss_sum, n, top1, highconf_err]
	const agg: Record<string, Record<string, [number, number, number, number]>> = {}

	for (const m of methods) {
		agg[m] = { US: [0.0, 0, 0, 0], FR: [0.0, 0, 0, 0] }
	}

	for (const [pc, truth] of test) {
		const post = posteriors(pc, count, total)

		for (const m of methods) {
			const p = post[m]!
			const a = agg[m]![truth]!
			a[0] += -Math.log(Math.max(p[truth]!, 1e-12))
			a[1] += 1
			const arg = argmax(p, cands)

			if (arg === truth) {
				a[2] += 1
			} else if (p[arg]! > 0.8) {
				a[3] += 1
			}
		}
	}

	const line = (label: string, [ll, n, t1, hce]: [number, number, number, number]): string =>
		`    ${padL(label, 8)} logloss=${pyFixed(ll / Math.max(n, 1), 4)}  top1=${padR(pyFixed((100 * t1) / Math.max(n, 1), 1), 5)}%  highconf-err=${padR(pyFixed((100 * hce) / Math.max(n, 1), 1), 4)}%  (n=${n})`

	console.log("=".repeat(78))

	for (const m of methods) {
		const us = agg[m]!.US!
		const fr = agg[m]!.FR!
		const balLl = 0.5 * (us[0] / Math.max(us[1], 1) + fr[0] / Math.max(fr[1], 1))
		const balT1 = 0.5 * (us[2] / Math.max(us[1], 1) + fr[2] / Math.max(fr[1], 1))
		console.log(`\n[${m}]`)
		console.log(line("true=US", us))
		console.log(line("true=FR", fr))
		console.log(`    BALANCED logloss=${pyFixed(balLl, 4)}  top1=${pyFixed(100 * balT1, 1)}%   <-- the fair number`)
	}
	console.log("\n" + "=".repeat(78))
	console.log("Lower balanced logloss = better-calibrated posterior. Higher balanced top1 = picks the right")
	console.log("country more often on genuine collisions. de_biased should beat uniform; naive_count is the")
	console.log("control showing why raw counts were feared.")
}

if (import.meta.main) {
	await main()
}
