/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Latin-script off-map outlier exposure for the #244 coarse-placer (milestone 3). M2's OTHER class
 *   was trained on NON-Latin/non-CJK scripts (Cyrillic, Arabic, …) from WOF names, so off-map
 *   COUNTRIES written in Latin script (Poland, Brazil, Mexico, …) still mis-place to a trained
 *   Latin country (the "Latin-off-map residual"). The fix is REAL off-map addresses (not synthetic
 *   name variants — see #564: synthetic mass fits its own quirks): assemble address strings from
 *   the Overture per-country address parquet and append them as `country: "OTHER"`.
 *
 *   Discipline: countries split into TRAIN (their rows feed train/val OTHER) and HELDOUT (rows go
 *   ONLY to the dedicated test file), so we can measure generalization to off-map countries the
 *   model never saw — not just memorization. The in-map test.jsonl is left UNTOUCHED so the
 *   before/after in-map regression check stays clean; the Latin metric lives in its own file.
 *
 *   Run AFTER build-dataset.mjs + build-outlier-exposure.mjs (it appends). Re-runnable: it rewrites
 *   the dedicated test file and appends fresh OTHER rows (so don't run it twice onto the same
 *   splits without rebuilding train/val).
 *
 *   Usage: node scripts/coarse-placer/build-outlier-latin.mjs [--per-country 6000] [--overture
 *   $MAILWOMAN_DATA_ROOT/overture/2026-05-20.0]
 */
import { dataRootPath } from "@mailwoman/core/utils"
import { appendFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

const { values: args } = parseArgs({
	options: {
		"per-country": { type: "string", default: "6000" },
		overture: { type: "string", default: dataRootPath("overture", "2026-05-20.0") },
		data: { type: "string", default: path.resolve(import.meta.dirname, "../../data/coarse-placer") },
	},
})
const PER = Number(args["per-country"])

// Off-map (NOT among the trained countries) and Latin-script. TRAIN feeds the OTHER class; HELDOUT
// is test-only — the generalization probe (unseen off-map countries should still route OTHER).
// #743: PL/PT/CZ moved from OTHER to FIRST-CLASS in-map countries (they're now in COARSE_CLASSES),
// so they're removed here — keeping them would feed contradictory gold (the same address labelled
// both PL and OTHER). That leaves BR/MX as the Latin off-map TRAIN exposure and CA/LI as the
// heldout probe (the hard near-twins of in-map US/DE — an honest worst case). The in-map expansion
// itself shrinks the off-map Latin surface, and the bulk OTHER exposure is non-Latin (build-
// outlier-exposure.mjs), so the thinner Latin train set is acceptable; watch OTHER-Latin recall in
// the openset eval.
const TRAIN_COUNTRIES = ["BR", "MX"]
const HELDOUT_COUNTRIES = ["CA", "LI"]

/** Address_levels arrives as a list (node-api) or its string repr; pull the value strings out. */
function levelValues(al) {
	if (Array.isArray(al)) return al.map((x) => (x && x.value ? String(x.value) : "")).filter(Boolean)
	const s = String(al ?? "")
	const out = []
	for (const m of s.matchAll(/'value':\s*'([^']*)'/g)) out.push(m[1])
	if (!out.length) for (const m of s.matchAll(/"value":\s*"([^"]*)"/g)) out.push(m[1])
	return out
}

/** FNV-1a → uint32, for deterministic ordering/variant choice. */
function hash(s) {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}

/** Assemble a plausible address string from an Overture address row. Deterministic variant by hash. */
function assemble(r) {
	const num = (r.number ?? "").toString().trim()
	const street = (r.street ?? "").toString().trim()
	const pc = (r.postcode ?? "").toString().trim()
	const levels = levelValues(r.address_levels)
	const locality = (r.postal_city ? String(r.postal_city) : "") || levels[levels.length - 1] || levels[0] || ""
	if (!street && !locality) return null // nothing distinctive
	const head = [num, street].filter(Boolean).join(" ")
	const tail = [pc, locality].filter(Boolean).join(" ")
	const h = hash(`${num}|${street}|${pc}|${locality}`)
	switch (h % 3) {
		case 0:
			return [head, tail].filter(Boolean).join(", ")
		case 1:
			return [head, locality, pc].filter(Boolean).join(", ").trim()
		default:
			return [head, [locality, pc].filter(Boolean).join(" ")].filter(Boolean).join(", ")
	}
}

const duck = await (await DuckDBInstance.create()).connect()

async function rowsFor(cc) {
	const f = path.join(args.overture, `addresses-${cc.toLowerCase()}.parquet`)
	let res
	try {
		res = await duck.runAndReadAll(
			`SELECT number, street, postcode, postal_city, address_levels FROM read_parquet('${f}') LIMIT ${PER}`
		)
	} catch (e) {
		console.error(`  ${cc}: SKIP (${e.message.split("\n")[0]})`)
		return []
	}
	const seen = new Set()
	const out = []
	for (const r of res.getRowObjects()) {
		const raw = assemble(r)
		if (!raw || seen.has(raw) || raw.length < 6) continue
		seen.add(raw)
		out.push(raw)
	}
	return out
}

const trainAppend = []
const valAppend = []
const testRows = [] // dedicated Latin off-map test: {raw, country:"OTHER", group, srcCountry}

for (const cc of TRAIN_COUNTRIES) {
	const rows = (await rowsFor(cc)).sort((a, b) => hash(a) - hash(b))
	const nVal = Math.floor(rows.length * 0.1)
	const nTest = Math.floor(rows.length * 0.1)
	const val = rows.slice(0, nVal)
	const test = rows.slice(nVal, nVal + nTest)
	const train = rows.slice(nVal + nTest)
	for (const raw of train) trainAppend.push(raw)
	for (const raw of val) valAppend.push(raw)
	for (const raw of test) testRows.push({ raw, country: "OTHER", group: "indist", srcCountry: cc })
	console.log(`  TRAIN ${cc}: ${rows.length} (train ${train.length} / val ${val.length} / test ${test.length})`)
}
for (const cc of HELDOUT_COUNTRIES) {
	const rows = await rowsFor(cc)
	for (const raw of rows) testRows.push({ raw, country: "OTHER", group: "heldout", srcCountry: cc })
	console.log(`  HELDOUT ${cc}: ${rows.length} (test-only)`)
}
duck.disconnect?.()

// Append OTHER rows to train/val; write the dedicated Latin off-map test file.
const wr = (rows) => rows.map((raw) => JSON.stringify({ raw, country: "OTHER" })).join("\n") + "\n"
appendFileSync(path.join(args.data, "train.jsonl"), wr(trainAppend))
appendFileSync(path.join(args.data, "val.jsonl"), wr(valAppend))
writeFileSync(path.join(args.data, "test-latin-offmap.jsonl"), testRows.map((r) => JSON.stringify(r)).join("\n") + "\n")
console.log(`\nappended OTHER → train +${trainAppend.length}, val +${valAppend.length}`)
console.log(
	`wrote test-latin-offmap.jsonl: ${testRows.length} rows (indist ${testRows.filter((r) => r.group === "indist").length} / heldout ${testRows.filter((r) => r.group === "heldout").length})`
)
