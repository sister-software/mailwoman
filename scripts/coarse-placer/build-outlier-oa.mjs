/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAddresses Latin-off-map outlier exposure for the #244 coarse-placer (milestone 3, breadth).
 *   The successor to build-outlier-latin.mjs (Overture): Overture's ALPHA addresses theme only
 *   carries real rows for ~7 off-map countries, so a model trained on them MEMORIZED rather than
 *   learned an "off-map" boundary (night-15 finding). OpenAddresses covers far more countries —
 *   this assembles address strings from OA's per-country CSVs and appends them as `country:
 *   "OTHER"`.
 *
 *   Discipline (per the #244 scoping note + DeepSeek consult):
 *
 *   - LEAVE-ONE-LANGUAGE-FAMILY-OUT, not random: whole families are held out (Nordic, Baltic, …) so a
 *       trained sibling's shared n-grams can't rescue the generalization metric. TRAIN families
 *       feed train/val/test(indist); HELDOUT families go ONLY to the dedicated test file.
 *   - Schema variance: read via DuckDB read_csv_auto(..., union_by_name) so differing per-source OA
 *       schemas align; assemble to the SAME format the in-map rows use (build-outlier-latin's
 *       assemble).
 *   - Dedup (per country) + per-country CAP (downsample): PL/CZ dwarf others, so cap so OTHER isn't
 *       "mostly Polish".
 *   - Country filter: only OFF-MAP countries (never the 11 in-map); the in-map test.jsonl is untouched.
 *
 *   Run AFTER build-dataset.mjs + build-outlier-exposure.mjs (it APPENDS). Re-runnable: rewrites the
 *   dedicated test file and appends fresh OTHER rows — rebuild train/val before re-running.
 *
 *   Usage: node scripts/coarse-placer/build-outlier-oa.mjs --oa-dir <extracted-OA-root>
 *   [--per-country 6000] [--data data/coarse-placer]
 */
import { appendFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

const { values: args } = parseArgs({
	options: {
		"oa-dir": { type: "string", default: "/mnt/playpen/mailwoman-data/openaddresses/extracted" },
		"per-country": { type: "string", default: "6000" },
		data: { type: "string", default: path.resolve(import.meta.dirname, "../../data/coarse-placer") },
	},
})
const PER = Number(args["per-country"])

// The 11 IN-MAP countries the coarse-placer routes to — never appear in OTHER. (build-dataset.mjs)
const IN_MAP = new Set(["US", "FR", "GB", "CN", "NL", "IT", "DE", "JP", "ES", "KR", "TW"])

// Language/region families for the leave-one-family-out split. Off-map countries OA's europe+asia zips
// plausibly carry; the actual TRAIN/HELDOUT set is intersected with what's on disk at runtime. HELDOUT
// families are the generalization probe (the model never sees a single row from them).
// Off-map families, intersected at runtime with what OA's europe+asia zips actually carry (verified
// on disk: ae at au be cz dk ee fi gr il is kw kz lt lu lv nc nz pl pt qa ro sa se sg si sk).
const FAMILIES = {
	slavic_latin: ["PL", "CZ", "SK", "SI"],
	romance_offmap: ["PT", "RO"],
	germanic_offmap: ["AT", "BE", "LU"],
	nordic: ["SE", "DK", "FI", "IS"],
	hellenic: ["GR"],
	central_asian: ["KZ"],
	maritime_asia: ["SG"],
	baltic: ["EE", "LV", "LT"],
	oceania: ["AU", "NZ", "NC"],
	middle_east: ["AE", "IL", "KW", "QA", "SA"],
}
// Leave-one-language-FAMILY-out probe (DeepSeek): hold out WHOLE families the model never sees a row
// from — Baltic (Latin, distinct), Oceania (English-Latin, distinct), Middle-East (romanized non-Latin).
const HELDOUT_FAMILIES = new Set(["baltic", "oceania", "middle_east"])

/** FNV-1a → uint32, deterministic ordering/variant choice. */
function hash(s) {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}

/** Assemble a plausible address string from an OA row — SAME shape variants as build-outlier-latin. */
function assemble(r) {
	const num = (r.number ?? "").toString().trim()
	const street = (r.street ?? "").toString().trim()
	const pc = (r.postcode ?? "").toString().trim()
	const locality = (r.city ?? "").toString().trim()
	if (!street && !locality) return null // nothing distinctive
	// Drop raw-coord-only / PO-box-ish noise (DeepSeek gotcha): need a real street or locality token.
	if (!street && !/[a-z]/i.test(locality)) return null
	const head = [num, street].filter(Boolean).join(" ")
	const h = hash(`${num}|${street}|${pc}|${locality}`)
	switch (h % 3) {
		case 0:
			return [head, [pc, locality].filter(Boolean).join(" ")].filter(Boolean).join(", ")
		case 1:
			return [head, locality, pc].filter(Boolean).join(", ").trim()
		default:
			return [head, [locality, pc].filter(Boolean).join(" ")].filter(Boolean).join(", ")
	}
}

const duck = await (await DuckDBInstance.create()).connect()

/** Read+assemble up to PER deduped rows for a country from its OA CSVs (glob under <oa>/**/<cc>/). */
async function rowsFor(cc) {
	const lc = cc.toLowerCase()
	// OA collected layout: `<cc>/[<region>/]<source>.csv` (country at root; `summary/` excluded by
	// rooting the glob at <cc>). `**` matches zero-or-more dirs → handles both flat + region-nested.
	const glob = path.join(args["oa-dir"], lc, "**", "*.csv")
	let res
	try {
		res = await duck.runAndReadAll(
			// union_by_name aligns the differing per-source schemas; LOWER the header access so NUMBER /
			// number both resolve. Pull a generous superset, dedup+cap in JS.
			`SELECT COLUMNS('(?i)^(number|street|city|postcode)$') FROM read_csv_auto('${glob}', union_by_name=true, ignore_errors=true, sample_size=-1) LIMIT ${PER * 8}`
		)
	} catch (e) {
		console.error(`  ${cc}: SKIP (${e.message.split("\n")[0]})`)
		return []
	}
	const seen = new Set()
	const out = []
	for (const r of res.getRowObjects()) {
		// COLUMNS() preserves source-case keys; normalize to lowercase access.
		const row = {}
		for (const [k, v] of Object.entries(r)) row[k.toLowerCase()] = v
		const raw = assemble(row)
		if (!raw || raw.length < 6 || seen.has(raw)) continue
		seen.add(raw)
		out.push(raw)
		if (out.length >= PER) break
	}
	return out.sort((a, b) => hash(a) - hash(b))
}

const trainAppend = []
const valAppend = []
const testRows = [] // {raw, country:"OTHER", group, srcCountry, family}
let trainCC = 0
let heldCC = 0

for (const [family, countries] of Object.entries(FAMILIES)) {
	const heldout = HELDOUT_FAMILIES.has(family)
	for (const cc of countries) {
		if (IN_MAP.has(cc)) continue
		const rows = await rowsFor(cc)
		if (rows.length === 0) continue
		if (heldout) {
			for (const raw of rows) testRows.push({ raw, country: "OTHER", group: "heldout", srcCountry: cc, family })
			heldCC++
			console.log(`  HELDOUT ${cc} (${family}): ${rows.length} (test-only)`)
		} else {
			const nVal = Math.floor(rows.length * 0.1)
			const nTest = Math.floor(rows.length * 0.1)
			for (const raw of rows.slice(0, nVal)) valAppend.push(raw)
			for (const raw of rows.slice(nVal, nVal + nTest))
				testRows.push({ raw, country: "OTHER", group: "indist", srcCountry: cc, family })
			for (const raw of rows.slice(nVal + nTest)) trainAppend.push(raw)
			trainCC++
			console.log(`  TRAIN ${cc} (${family}): ${rows.length}`)
		}
	}
}
duck.disconnect?.()

const wr = (rows) => rows.map((raw) => JSON.stringify({ raw, country: "OTHER" })).join("\n") + "\n"
appendFileSync(path.join(args.data, "train.jsonl"), wr(trainAppend))
appendFileSync(path.join(args.data, "val.jsonl"), wr(valAppend))
writeFileSync(path.join(args.data, "test-latin-offmap.jsonl"), testRows.map((r) => JSON.stringify(r)).join("\n") + "\n")
console.log(`\nTRAIN countries: ${trainCC} · HELDOUT countries: ${heldCC}`)
console.log(`appended OTHER → train +${trainAppend.length}, val +${valAppend.length}`)
console.log(
	`wrote test-latin-offmap.jsonl: ${testRows.length} (indist ${testRows.filter((r) => r.group === "indist").length} / heldout ${testRows.filter((r) => r.group === "heldout").length})`
)
