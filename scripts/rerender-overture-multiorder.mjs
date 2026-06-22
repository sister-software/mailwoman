#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #148 v1.9.1 — RE-RENDER the overture multi-locale canonical jsonl in THREE ORDERS to break the
 *   positional shortcut that sank v1.9.0. The v1.9.0 shard was 100% canonical ("STREET HN, PC TOWN"
 *   — town always LAST), so at source-weight 3.0 (the SOLE EU-format teacher) the model learned
 *   "locality = last token-group" and emitted the STREET as locality on the eval's pc-first /
 *   city-first orders (confirmed by scripts/eval/locality-emit-diff.ts: Alvito→"R Alexandre
 *   Herculano"). Diagnosis: ORDER-overfit, NOT a grain mismatch and NOT a weight problem (source_weights
 *   is a MULTINOMIAL over sources, so row count / weight don't change the 5.7% EU mass — only the
 *   rendering does). Fix = present the SAME rows in all three natural orders.
 *
 *   ONE-KNOB DISCIPLINE: this changes ONLY the render order. Same 2.4M rows, same components, same
 *   source_id, same weight (3.0). v1.9.0 → v1.9.1 is then a clean single-variable A/B.
 *
 *   Mechanism: rotate order ∈ {canonical, pc-first, city-first} by line index. The input is
 *   locale-BLOCKED (all SK, then SI, …), so i%3 gives every locale an even 1/3 split. We MOVE
 *   substrings rather than re-compose from components: the adapter's canonical raw is
 *   "<street-group>, <place-group>" (street-group before the FIRST comma, place-group after), so we
 *   split there — preserving the adapter's exact within-street-group token order (IT renders unit
 *   before house_number, "1 7"; re-composing would scramble that and risk a mislabel). Only the
 *   locality/postcode within the place-group is re-ordered for city-first, using the component values
 *   verbatim. Every variant is validated substring-present (the alignRow precondition); on any failure
 *   we fall back to the canonical raw (always valid — it's the adapter's own output). Postcode-less
 *   locales (IT/NL/CZ/DE-partial/SK, ~26%) still reorder: place-group is the locality alone, so
 *   pc-first/city-first both put the town FIRST — exactly the position the model was blind to.
 *
 *   Pipeline (feeds the standard overlay path):
 *     node scripts/rerender-overture-multiorder.mjs --input /tmp/ovl/overture-ml.canonical.jsonl \
 *       --output /tmp/ovl/overture-ml.3order.jsonl
 *     node scripts/align-canonical-shard.mjs --input /tmp/ovl/overture-ml.3order.jsonl \
 *       --output /tmp/ovl/overture-ml.3order.labeled.jsonl --corpus-version 0.5.0
 *     python3 scripts/jsonl-to-parquet.py --input <labeled> --output <NEW>/train/part-overture-multilocale-3order-train.parquet
 *     python3 scripts/assemble-overlay-manifest.py --base <v0.8.0 MANIFEST> --new-dir <NEW> \
 *       --modal-root /data/corpus/versioned/v0.9.1-multilocale/<dir> --version 0.9.1-multilocale \
 *       --shard-parquet part-overture-multilocale-3order-train.parquet --source overture --note "..."
 */
import { createReadStream, createWriteStream } from "node:fs"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"

const { values: a } = parseArgs({
	options: {
		input: { type: "string", default: "/tmp/ovl/overture-ml.canonical.jsonl" },
		output: { type: "string", default: "/tmp/ovl/overture-ml.3order.jsonl" },
	},
})

const ORDERS = ["canonical", "pc-first", "city-first"]

/**
 * Re-order a canonical overture row into the requested natural order, returning the new `raw` string
 * (or null to signal "fall back to canonical"). The canonical raw ALWAYS ends with the place-group
 * "<postcode> <locality>" (or "<locality>" when postcode-less), so we anchor on that tail — strip it
 * to get the leading "street-stuff" (everything before it, which may itself contain commas, e.g. the
 * ES "STREET, HN, PC LOCALITY" 3-field format), then move the WHOLE street-stuff substring. This
 * preserves the adapter's within-street token order exactly AND keeps a comma-separated house_number
 * field intact (splitting at the first comma instead would strand it and fail the validity check).
 */
function reorder(raw, c, order) {
	if (order === "canonical") return raw
	if (!c.locality) return null // a meaningful pc/city-first needs the locality up front
	const placeGrp = c.postcode ? `${c.postcode} ${c.locality}` : c.locality
	if (!raw.endsWith(placeGrp)) return null // not a "…, <place-group>" canonical tail — leave it
	const streetStuff = raw.slice(0, raw.length - placeGrp.length).replace(/[,\s]+$/, "")
	if (!streetStuff) return null
	if (order === "pc-first") {
		// place-group (postcode+locality, or locality alone) leads; street-stuff trails.
		return `${placeGrp}, ${streetStuff}`
	}
	// city-first: locality, [postcode,] street-stuff — locality isolated first.
	return c.postcode ? `${c.locality}, ${c.postcode}, ${streetStuff}` : `${c.locality}, ${streetStuff}`
}

/** alignRow precondition: every component surface must appear verbatim in raw. */
function valid(raw, c) {
	for (const v of Object.values(c)) {
		if (v && !raw.includes(v)) return false
	}
	return true
}

async function main() {
	const out = createWriteStream(a.output, { encoding: "utf8" })
	const rl = createInterface({ input: createReadStream(a.input, { encoding: "utf8" }), crlfDelay: Infinity })
	let i = 0
	let fallback = 0
	const counts = { canonical: 0, "pc-first": 0, "city-first": 0 }
	const perLocale = {} // cc -> {canonical, pc-first, city-first}
	for await (const line of rl) {
		if (!line) continue
		const row = JSON.parse(line)
		const order = ORDERS[i++ % 3]
		let raw = row.raw
		let used = "canonical"
		if (order !== "canonical") {
			const r = reorder(row.raw, row.components, order)
			if (r && valid(r, row.components)) {
				raw = r
				used = order
			} else {
				fallback++
			}
		}
		counts[used]++
		const cc = row.country || "??"
		;(perLocale[cc] ??= { canonical: 0, "pc-first": 0, "city-first": 0 })[used]++
		out.write(JSON.stringify({ ...row, raw, synth_order: used }) + "\n")
	}
	await new Promise((r) => out.end(r))
	console.error(`rerendered ${i.toLocaleString()} rows: ${JSON.stringify(counts)} (fallback-to-canonical=${fallback.toLocaleString()})`)
	console.error(`-> ${a.output}`)
	// Per-locale order split — confirm postcode-less locales (IT/NL/CZ) still get the town-first orders.
	for (const cc of Object.keys(perLocale).sort()) {
		const p = perLocale[cc]
		const tot = p.canonical + p["pc-first"] + p["city-first"]
		console.error(`  ${cc}: canon ${p.canonical} | pc-first ${p["pc-first"]} | city-first ${p["city-first"]} (n=${tot})`)
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
