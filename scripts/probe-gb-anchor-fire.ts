/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does the GB postcode-anchor binary actually FIRE on the gb-golden board, and by which route?
 *
 *   The instrument `docs/records/evals/2026-08-05-en-gb-anchor-off.md` used ("anchor fired on 106/120
 *   rows") replayed `buildAnchorFeatures`'s DEFAULT recognizer — alphanumeric run → `lookup.get(UPPER)`.
 *   A model trained against the widened anchor-v2 lookup serves under `span_mode: "shaped"` instead, so
 *   this replays THAT recognizer: `collectMatches` shape spans, keyed
 *   `span.replaceAll(" ", "").toUpperCase()`, with `buildAnchorFeatures`'s GB outward fallback.
 *
 *   Reported per register, because the shape detector reads the raw text and the register is the first
 *   thing that could silently cost a span. Three failure modes are distinguished, and they have
 *   different diagnoses: NO SHAPED SPAN (the detector never proposed one — a `collectMatches` gap),
 *   SPAN BUT NO KEY (the detector proposed one and the lookup does not carry it — a coverage gap, e.g.
 *   a Northern Ireland `BT` code Code-Point Open does not carry), and a hit via the outward fallback
 *   rather than the unit (the unit is absent but its district anchors the span).
 *
 *   Usage: node scripts/probe-gb-anchor-fire.ts --bin <postcode-gb.bin>
 */

// `@mailwoman/neural` exports neither `./postcode-repair` nor `./case-normalize` as a subpath, and both
// are required here: `collectMatches` is the exact span source `buildAnchorFeatures`'s shaped mode
// reads, and `normalizeInputCase` is what the text has been through by the time the anchor sees it
// (#690, default-ON in `parse`). Re-implementing either is the one thing that must not drift, so this
// repo-local diagnostic imports the modules directly.
import { normalizeInputCase } from "@mailwoman/neural/case-normalize"
import { PostcodeBinaryResolver } from "@mailwoman/neural/postcode-binary-resolver"
import { collectMatches } from "@mailwoman/neural/postcode-repair"
import { readFileSync } from "@mailwoman/platform/fs"
import { parseArgs } from "@mailwoman/platform/util"
import { JSONSpliterator } from "spliterator"

/**
 * A GB unit key in the space-stripped form, mirroring `neural/anchor-inference.ts`'s outward fallback guard.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/
const GB_INWARD_LENGTH = 3

const { values } = parseArgs({
	options: {
		bin: { type: "string" },
		fixtures: { type: "string", default: "packages/mailwoman/eval-harness/fixtures/gb-golden.jsonl" },
	},
})

if (!values.bin) throw new Error("--bin <postcode-gb.bin> is required")

const lookup = new PostcodeBinaryResolver(new Uint8Array(readFileSync(values.bin))).toAnchorLookup()

console.log(`anchorLookupPath ${values.bin}`)
console.log(`anchor lookup keys: ${lookup.size.toLocaleString()}`)

const rows = await Array.fromAsync(
	JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(values.fixtures!)
)

/**
 * `parse` builds the anchor from the CASE-NORMALIZED text, not the raw input. That matters more here than anywhere
 * else: the alphanumeric shape patterns require UPPERCASE letters by design, so on the raw text a lowercased GB unit
 * yields no shaped span at all and the channel is silently dead. `normalizeInputCase` is what saves it — it restores
 * postcode casing in both the all-caps and all-lower registers. Probing the raw text would report a register asymmetry
 * that production does not have; probing the normalized text is the serving truth.
 */
const NORMALIZE_CASE = true

for (const register of ["asis", "lower", "upper"] as const) {
	let fired = 0
	let viaUnit = 0
	let viaOutward = 0
	let noSpan = 0
	let spanMiss = 0
	const missed: string[] = []

	for (const row of rows) {
		const raw = register === "lower" ? row.raw.toLowerCase() : register === "upper" ? row.raw.toUpperCase() : row.raw

		const text = NORMALIZE_CASE ? normalizeInputCase(raw) : raw
		const spans = [...collectMatches(text)]

		if (!spans.length) {
			noSpan++

			continue
		}

		let hit = false

		for (const match of spans) {
			const key = text.slice(match.start, match.end).replaceAll(" ", "").toUpperCase()

			if (lookup.get(key)) {
				hit = true

				viaUnit++

				break
			}

			if (GB_UNIT_KEY.test(key) && lookup.get(key.slice(0, -GB_INWARD_LENGTH))) {
				hit = true

				viaOutward++

				break
			}
		}

		if (hit) {
			fired++
		} else {
			spanMiss++
			missed.push(text)
		}
	}

	console.log(
		`${register.padEnd(6)} fired ${fired}/${rows.length} (unit ${viaUnit} · outward-fallback ${viaOutward}) · ` +
			`no shaped span ${noSpan} · span-but-no-key ${spanMiss}`
	)

	if (missed.length) {
		console.log(`       span-but-no-key: ${JSON.stringify(missed.slice(0, 6))}`)
	}
}
