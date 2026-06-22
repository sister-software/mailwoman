#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #148 — produce the CANONICAL jsonl for the overture-multilocale training shard (the multi-locale
 *   parse-recall lever). Runs the `overture` corpus adapter over the per-country Overture address
 *   JSONL (#149, release 2026-06-17.0) for a set of EU locales, capping rows/locale for balance +
 *   a bounded local build, and writes ONE combined canonical jsonl ({raw, components, country,
 *   source, source_id}). That feeds the standard overlay path:
 *
 *     node scripts/build-overture-multilocale-canonical.mjs --cap 150000 --out /tmp/ovl/overture-ml.canonical.jsonl
 *     node scripts/align-canonical-shard.mjs --input <canonical> --output <labeled> --corpus-version 0.5.0
 *     python3 scripts/jsonl-to-parquet.py --input <labeled> --output <NEW>/train/part-overture-multilocale-train.parquet
 *     python3 scripts/assemble-fr-admin-split-overlay-manifest.py ... (overlay onto v0.8.0)
 *
 *   WHY: the model is en-us/fr-trained; the 8-locale coordinate panel (2026-06-22) showed resolve
 *   rate tracks training representation (FR/IT ~80%, mid-tier PT/PL/AT/CZ ~50%). This shard gives the
 *   model the non-en/fr street + locality formats it never saw. Gated on the coordinate panel.
 */
import { BUILTIN_ADAPTERS } from "@mailwoman/corpus"
import { createWriteStream, existsSync } from "node:fs"
import { parseArgs } from "node:util"

const overtureAdapter = BUILTIN_ADAPTERS.find((a) => a.id === "overture")
if (!overtureAdapter) throw new Error("overture adapter not found in BUILTIN_ADAPTERS (compile @mailwoman/corpus?)")

const REL = "/mnt/playpen/mailwoman-data/overture/2026-06-17.0"
// All EU locales with an Overture corpus JSONL on disk (the #149 ingest). AU deferred (non-EU,
// southern, cross-state collisions — a separate harder case).
const LOCALES = ["es", "it", "nl", "pt", "be", "pl", "de", "at", "ch", "cz", "dk", "no", "se", "fi", "ie", "gb", "sk", "si", "hr", "hu"]

const { values: a } = parseArgs({
	options: {
		cap: { type: "string", default: "150000" }, // rows per locale
		out: { type: "string", default: "/tmp/ovl/overture-ml.canonical.jsonl" },
		locales: { type: "string" }, // optional comma list override (for smoke tests)
	},
})
const cap = Number(a.cap)
const locales = (a.locales ? a.locales.split(",") : LOCALES).map((s) => s.trim().toLowerCase())
const out = createWriteStream(a.out)

let grand = 0
let shapeLogged = false
for (const cc of locales) {
	const inputPath = `${REL}/overture-${cc}.corpus.jsonl`
	if (!existsSync(inputPath)) {
		console.error(`  ${cc}: ${inputPath} missing — skipped`)
		continue
	}
	let n = 0
	for await (const row of overtureAdapter.rows({ inputPath, country: cc.toUpperCase() })) {
		if (!shapeLogged) {
			console.error(`  first row shape: ${JSON.stringify(row).slice(0, 200)}`)
			shapeLogged = true
		}
		out.write(JSON.stringify(row) + "\n")
		if (++n >= cap) break
	}
	grand += n
	console.error(`  ${cc.toUpperCase()}: +${n.toLocaleString()} canonical rows`)
}
await new Promise((r) => out.end(r))
console.error(`\n→ ${a.out}: ${grand.toLocaleString()} canonical rows across ${locales.length} locales (cap ${cap.toLocaleString()}/locale)`)
