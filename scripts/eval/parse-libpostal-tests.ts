/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parse libpostal's test/test_parser.c into mailwoman-schema {input, expected} cases.
 *
 *   Libpostal (openvenues/libpostal, MIT) is a _statistical_ address parser of a different lineage
 *   than our Pelias-derived v0 — so its hand-curated adversarial test cases are an UNBIASED
 *   cross-architecture benchmark (our own suite is a Pelias/addressit port, so v0 scores ~100% on
 *   it tautologically).
 *
 *   Fetch the source first: curl -sL
 *   https://raw.githubusercontent.com/openvenues/libpostal/master/test/test_parser.c -o
 *   /tmp/test_parser.c Then: node --experimental-strip-types scripts/eval/parse-libpostal-tests.ts
 *   /tmp/test_parser.c data/eval/external/libpostal-cases.jsonl
 *
 *   Run it through the harness (fair symmetric matching — see --symmetric-match): node
 *   --experimental-strip-types scripts/harness-v0-neural.ts\
 *   --tests <empty-dir> --falsehoods <dir-with-this-jsonl>\
 *   --model <onnx> --tokenizer <spm> --model-card <json>\
 *   --postcode-repair --symmetric-match --out-json /tmp/libpostal-bench.json
 *
 *   Tag remap (libpostal -> mailwoman): road->street, city->locality, state->region, house->venue,
 *   suburb->dependent_locality, city_district->dependent_locality (or locality when no city
 *   present). Unmappable libpostal tags
 *   (level/staircase/entrance/building/metro_station/world_region/...) are DROPPED from the
 *   expected (not scored) — so use --symmetric-match so v0 is scored on the same subset.
 *
 *   Ported faithfully from scripts/eval/parse-libpostal-tests.py.
 */

import { readFileSync, writeFileSync } from "node:fs"

import { pyJsonDumps } from "@mailwoman/core/utils"

const REMAP: Record<string, string> = {
	road: "street",
	house_number: "house_number",
	city: "locality",
	state: "region",
	postcode: "postcode",
	country: "country",
	unit: "unit",
	po_box: "po_box",
	house: "venue",
	suburb: "dependent_locality",
}
const DROP = new Set([
	"level",
	"staircase",
	"entrance",
	"building",
	"metro_station",
	"world_region",
	"country_region",
	"island",
	"state_district",
	"website",
	"phone",
])

function main(): void {
	const srcPath = process.argv[2] ?? "/tmp/test_parser.c"
	const outPath = process.argv[3] ?? "data/eval/external/libpostal-cases.jsonl"
	const src = readFileSync(srcPath, "utf-8")

	const callRe = /test_parse_result_equals\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*\w+\s*,\s*\d+\s*,(.*?)\)\s*\)/gs
	const pairRe = /\(labeled_component_t\)\{\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}/g

	const cases: Array<Record<string, unknown>> = []

	for (const call of src.matchAll(callRe)) {
		const inp = call[1]!
		const body = call[2]!
		const pairs = [...body.matchAll(pairRe)].map((m) => [m[1]!, m[2]!] as const)

		if (pairs.length === 0) continue
		const hasCity = pairs.some(([l]) => l === "city")
		const exp: Record<string, string[]> = {}

		for (const [lbl, val] of pairs) {
			if (DROP.has(lbl)) continue
			const tag = lbl === "city_district" ? (hasCity ? "dependent_locality" : "locality") : REMAP[lbl]

			if (!tag) continue
			;(exp[tag] ??= []).push(val.toLowerCase())
		}

		if (Object.keys(exp).length > 0) {
			cases.push({ input: inp.replaceAll('\\"', '"'), locale: "en-US", expected: exp, source: "libpostal" })
		}
	}

	writeFileSync(outPath, cases.map((c) => pyJsonDumps(c) + "\n").join(""))
	console.log(`wrote ${cases.length} cases to ${outPath}`)
}

main()
