/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #444 — the FR accent-mangle rate, as a SAVED, reproducible harness (the 2026-07-09 issue comment
 *   measured "13.4% of accented FR streets get a mangled street key" with an inline diagnostic that was
 *   never committed — this is that diagnostic, tracked).
 *
 *   The metric. The BAN address-point tier (`AddressPointSqliteLookup.find`) keys a query on
 *   `normalizeStreetForKeyLocale(parsedStreetSpan, "fr")` and matches `street_norm` exactly. Build-side
 *   and probe-side share that ONE normalizer, so a pure accent folds identically on both sides — the ONLY
 *   way a probe misses is the PARSER emitting a different street string (dropping/fragmenting an accented
 *   char). So: draw a rowid-ordered (non-alphabetical, fair) sample of distinct accented BAN streets, parse
 *   a realistic `number street, postcode locality` address for each, fold the parsed street span, and count
 *   rows whose folded key != the stored `street_norm`. That count IS the address-point-tier accent gap, and
 *   it is entirely upstream of the keying.
 *
 *   Two arms, each a full (model, tokenizer, card) trio via {@link createScorer} so anchor/gazetteer soft-feeds
 *   are wired identically — the ONLY variables are the ONNX + the vocab. Never compares parse-F1 across
 *   tokenizer versions; it grades the COORDINATE-relevant street key + a direct address-point DB probe
 *   (MISS→HIT) on the named #444 datapoints.
 *
 *   Run (baseline = shipped v5.4.0 int8 + v0.7.1-nsplice; candidate = FR-splice v240 int8 + v0.8.0-fr-nsplice):
 *     node scripts/eval/fr-accent-mangle-rate.ts \
 *       --base-model  $MAILWOMAN_DATA_ROOT/models/candidates/v230-nl-postcode/model-int8.onnx \
 *       --base-tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.7.1-nsplice/tokenizer.model \
 *       --base-card   neural-weights-en-us/model-card.json \
 *       --cand-model  $MAILWOMAN_DATA_ROOT/models/candidates/v240-fr-nsplice/model-int8.onnx \
 *       --cand-tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.8.0-fr-nsplice/tokenizer.model \
 *       --cand-card   $MAILWOMAN_DATA_ROOT/models/candidates/v240-fr-nsplice/model-card.json \
 *       --n 1500
 */

import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createScorer, type NeuralAddressClassifier } from "@mailwoman/neural"
import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { mailwomanDataRoot } from "mailwoman/resolver-backend"

const STREET_TAGS = new Set(["street", "street_prefix", "street_suffix"])

const { values } = parseArgs({
	options: {
		"base-model": { type: "string" },
		"base-tokenizer": { type: "string" },
		"base-card": { type: "string", default: "neural-weights-en-us/model-card.json" },
		"cand-model": { type: "string" },
		"cand-tokenizer": { type: "string" },
		"cand-card": { type: "string" },
		db: { type: "string", default: `${mailwomanDataRoot()}/ban/address-points-fr.db` },
		n: { type: "string", default: "1500" },
	},
	strict: true,
})

const N = Number(values.n)

function req(name: string): string {
	const v = values[name as keyof typeof values] as string | undefined

	if (!v) throw new Error(`--${name} is required`)

	return resolve(v)
}

type Node = { tag: string; value: string; start: number; end: number; children: readonly Node[] }

/** The folded street key + the number of contiguous street spans (a gap > 2 chars ⇒ the span fragmented). */
function streetInfo(tree: { roots: readonly Node[] }): { key: string; spans: number } {
	const parts: Array<{ value: string; start: number; end: number }> = []
	const stack: Node[] = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!

		if (STREET_TAGS.has(n.tag) && n.value.trim()) { parts.push({ value: n.value.trim(), start: n.start, end: n.end }) }
		stack.push(...(n.children as Node[]))
	}

	parts.sort((a, b) => a.start - b.start)

	let spans = 0
	let prevEnd = -100

	for (const p of parts) {
		if (p.start - prevEnd > 2) { spans++ }
		prevEnd = p.end
	}

	return { key: normalizeStreetForKeyLocale(parts.map((p) => p.value).join(" "), "fr"), spans }
}

async function load(model: string, tokenizer: string, card: string): Promise<NeuralAddressClassifier> {
	return createScorer({ modelPath: model, tokenizerPath: tokenizer, modelCardPath: card, locale: "en-us" })
}

const baseline = await load(req("base-model"), req("base-tokenizer"), req("base-card"))
const candidate = await load(req("cand-model"), req("cand-tokenizer"), req("cand-card"))

const db = new DatabaseSync(resolve(values.db!), { readOnly: true })

// Distinct accented streets, rowid-ordered (fair, non-alphabetical). GLOB '*[^ -~]*' = any char outside
// printable ASCII (0x20–0x7e) ⇒ an accented/diacritic char.
const sample = db
	.prepare(
		`SELECT street_raw, street_norm, number, postcode, locality_norm FROM address_point
		 WHERE street_raw GLOB '*[^ -~]*' GROUP BY street_norm ORDER BY rowid LIMIT ?`
	)
	.all(N) as Array<{ street_raw: string; street_norm: string; number: string; postcode: string; locality_norm: string }>

const probe = db.prepare(
	`SELECT lat, lon FROM address_point WHERE postcode = ? AND street_norm = ? AND number = ? LIMIT 1`
)

type Tally = { mangled: number; fragmented: number; truncation: number }
const tally = (): Tally => ({ mangled: 0, fragmented: 0, truncation: 0 })
const base = tally()
const cand = tally()
let flippedToHit = 0 // base mangled → cand intact (address_point MISS → HIT)

const examples: string[] = []

for (const r of sample) {
	const want = r.street_norm
	const q = `${r.number} ${r.street_raw}, ${r.postcode} ${r.locality_norm}`
	const b = streetInfo(await baseline.parse(q, { postcodeRepair: true, normalizeCase: true }))
	const c = streetInfo(await candidate.parse(q, { postcodeRepair: true, normalizeCase: true }))

	const bMangled = b.key !== want
	const cMangled = c.key !== want

	if (bMangled) {
		base.mangled++

		if (b.spans > 1) { base.fragmented++ }
		else { base.truncation++ }
	}

	if (cMangled) {
		cand.mangled++

		if (c.spans > 1) { cand.fragmented++ }
		else { cand.truncation++ }
	}

	if (bMangled && !cMangled) {
		flippedToHit++

		if (examples.length < 12) { examples.push(`  ✓ "${r.street_raw}"  base→"${b.key}"  cand→"${c.key}"  (want "${want}")`) }
	}
}

const pct = (x: number) => ((x / sample.length) * 100).toFixed(1)

console.log(`\n=== #444 FR accent-mangle rate (n=${sample.length} distinct accented BAN streets, rowid-ordered) ===`)
console.log(`  BASELINE (shipped): mangled ${base.mangled}/${sample.length} (${pct(base.mangled)}%)  [frag ${base.fragmented} / trunc ${base.truncation}]`)
console.log(`  CANDIDATE (splice): mangled ${cand.mangled}/${sample.length} (${pct(cand.mangled)}%)  [frag ${cand.fragmented} / trunc ${cand.truncation}]`)
console.log(`  Δ mangle rate: ${pct(base.mangled)}% → ${pct(cand.mangled)}%  (${(((cand.mangled - base.mangled) / sample.length) * 100).toFixed(1)}pp)`)
console.log(`  address_point MISS→HIT (base mangled, cand intact): ${flippedToHit}`)

// --- Named #444 datapoints: parse both arms + probe the BAN address_point tier directly (MISS→HIT + coord) ---
const datapoints = [
	{ q: "55 Rue du Faubourg Saint-Honoré, 75008 Paris", number: "55", postcode: "75008", street_norm: "rue du faubourg saint honore" },
	{ q: "10 Avenue des Champs-Élysées, 75008 Paris", number: "10", postcode: "75008", street_norm: "avenue des champs elysees" },
	{ q: "1 Place René Cassin, 75001 Paris", number: "1", postcode: "75001", street_norm: "place rene cassin" },
	{ q: "1 Rue de la République, 13001 Marseille", number: "1", postcode: "13001", street_norm: "rue de la republique" },
]

console.log(`\n--- named #444 datapoints (parse key + direct BAN address_point probe) ---`)

for (const d of datapoints) {
	const b = streetInfo(await baseline.parse(d.q, { postcodeRepair: true, normalizeCase: true }))
	const c = streetInfo(await candidate.parse(d.q, { postcodeRepair: true, normalizeCase: true }))
	const hit = (key: string) => (probe.get(d.postcode, key, d.number) as { lat: number; lon: number } | undefined)
	const bh = hit(b.key)
	const ch = hit(c.key)
	console.log(`  "${d.q}"  (BAN holds street_norm="${d.street_norm}")`)
	console.log(`    base:  key="${b.key}"  ${bh ? `HIT ${bh.lat},${bh.lon}` : "MISS"}`)
	console.log(`    cand:  key="${c.key}"  ${ch ? `HIT ${ch.lat},${ch.lon}` : "MISS"}`)
}

console.log(`\nsample MISS→HIT flips:`)

for (const e of examples) { console.log(e) }

db.close()
