/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #251 PROBE VERDICT: does the fr-bare-street shard fix the bare-FR street-segmentation tail? Grade
 *   the SHIPPED v193a3 (symlink) vs the v194 probe (same tokenizer/card/anchor/gazetteer soft-feed —
 *   only the ONNX swapped, via loadFromWeights modelPath override) on:
 *     1. bare-FR street-intact rate, sampled from the OSM-FR shard (a DIFFERENT source than the BAN
 *        the probe trained on → cross-source held-out pattern test), + the named demo failures.
 *     2. US no-regression sanity: a few US addresses must parse identically (the lever must not move US).
 *
 *   GO = FR street-intact rises materially AND US holds. Run: node scripts/diagnostic/fr-parse-recall-verdict.ts
 */

import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { mailwomanDataRoot } from "mailwoman/resolver-backend"

const STREET_TAGS = new Set(["street", "street_prefix", "street_suffix"])
const PROBE_MODEL = resolve(process.env["PROBE_MODEL"] ?? "./out/v194-final/model.onnx")

const baseline = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const probe = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", modelPath: PROBE_MODEL })

function streetKey(tree: { roots: readonly { tag: string; value: string; start: number; children: readonly unknown[] }[] }): string {
	const parts: Array<{ value: string; start: number }> = []
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()! as { tag: string; value: string; start: number; children: readonly unknown[] }

		if (STREET_TAGS.has(n.tag) && n.value.trim()) parts.push({ value: n.value.trim(), start: n.start })
		stack.push(...(n.children as typeof stack))
	}
	parts.sort((a, b) => a.start - b.start)

	return normalizeStreetForKeyLocale(parts.map((p) => p.value).join(" "), "fr")
}

async function streetIntact(c: NeuralAddressClassifier, q: string, want: string): Promise<boolean> {
	const tree = await c.parse(q, { postcodeRepair: true, normalizeCase: true })

	return streetKey(tree) === want
}

// --- FR held-out sample from OSM-FR (NOT the BAN training source) + the named demo failures ---
const db = new DatabaseSync(`${mailwomanDataRoot()}/osm/address-points-fr-fr.db`, { readOnly: true })
const sample = db
	.prepare(
		`SELECT street_raw, number, locality_norm FROM address_point
		 WHERE locality_norm IS NOT NULL AND street_raw LIKE '% %' GROUP BY street_norm ORDER BY number LIMIT 60`
	)
	.all() as Array<{ street_raw: string; number: string; locality_norm: string }>

const demos = [
	{ street_raw: "Rue du Chevaleret", number: "181", locality_norm: "Paris" },
	{ street_raw: "Rue René Cassin", number: "181", locality_norm: "Paris" },
	{ street_raw: "Avenue des Champs-Élysées", number: "10", locality_norm: "Paris" },
]
const cases = [...demos, ...sample]

let baseOk = 0
let probeOk = 0
const flips: string[] = []

for (const r of cases) {
	const want = normalizeStreetForKeyLocale(r.street_raw, "fr")
	const q = `${r.number} ${r.street_raw}, ${r.locality_norm}` // BARE, no postcode
	const b = await streetIntact(baseline, q, want)
	const p = await streetIntact(probe, q, want)

	if (b) baseOk++

	if (p) probeOk++

	if (!b && p && flips.length < 8) flips.push(`  ✓ FIXED  "${r.street_raw}, ${r.locality_norm}"`)

	if (b && !p && flips.length < 16) flips.push(`  ✗ BROKE  "${r.street_raw}, ${r.locality_norm}"`)
}

// --- US no-regression: parses must be identical (the lever must not touch US) ---
const usCases = [
	"350 5th Ave, New York, NY",
	"1600 Pennsylvania Ave NW, Washington DC",
	"1 Infinite Loop, Cupertino, CA 95014",
	"233 S Wacker Dr, Chicago, IL",
]
let usSame = 0

for (const q of usCases) {
	const a = JSON.stringify((await baseline.parse(q, { postcodeRepair: true, normalizeCase: true })).roots)
	const c = JSON.stringify((await probe.parse(q, { postcodeRepair: true, normalizeCase: true })).roots)

	if (a === c) usSame++
}

const n = cases.length
console.log(`\n=== #251 fr-bare-street PROBE VERDICT (bare FR, no postcode; ${n} cases incl 3 named demos) ===`)
console.log(`  SHIPPED v193a3 : ${baseOk}/${n} street-intact  (${((baseOk / n) * 100).toFixed(0)}%)`)
console.log(`  PROBE   v194   : ${probeOk}/${n} street-intact  (${((probeOk / n) * 100).toFixed(0)}%)   Δ ${(((probeOk - baseOk) / n) * 100).toFixed(0)}pp`)
console.log(`  US no-regression: ${usSame}/${usCases.length} parses identical to shipped`)
console.log(`\nflips:`)
for (const f of flips) console.log(f)
