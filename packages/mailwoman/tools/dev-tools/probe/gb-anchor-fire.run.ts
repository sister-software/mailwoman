/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reports whether the GB postcode-anchor binary fires on the gb-golden board and by which route,
 *   replaying the `collectMatches` shaped recognizer that `parse` uses. Each register is reported
 *   separately. It reports three failure modes: no shaped span, a span whose key the lookup
 *   does not include. The third is a hit through the GB outward fallback.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/probe/gb-anchor-fire.run.ts --bin <postcode-gb.bin>
 */

// `@mailwoman/neural` exports no `./postcode-repair` subpath.
// `collectMatches` is the exact span source `buildAnchorFeatures`'s shaped mode reads.
// `normalizeInputCase` transforms the text before the anchor sees it.
// `parse` applies this transformation by default.
// These must not drift from `parse`, so this repo-local diagnostic imports the same modules.
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PostcodeBinaryResolver, collectMatches } from "@mailwoman/neural/postcode"
import { normalizeInputCase } from "@mailwoman/normalize/case"
import { JSONSpliterator } from "spliterator"

/**
 * A GB unit key in the space-stripped form, mirroring `neural/anchor-inference.ts`'s outward fallback guard.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/
const GB_INWARD_LENGTH = 3

const { values } = parseArguments({
	options: {
		bin: { type: "string" },
		fixtures: { type: "string", default: "packages/mailwoman/tools/eval-harness/fixtures/gb-golden.jsonl" },
	},
})

if (!values.bin) throw new Error("--bin <postcode-gb.bin> is required")

const lookup = new PostcodeBinaryResolver(new Uint8Array(await readLocalBuffer(values.bin))).toAnchorLookup()

console.log(`anchorLookupPath ${values.bin}`)
console.log(`anchor lookup keys: ${lookup.size.toLocaleString()}`)

const rows = await JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(
	values.fixtures!
).toArray()

/**
 * `parse` builds anchors from case-normalized text.
 *
 * Normalization restores postcode casing, so lowercase input still matches
 * the uppercase-only shape patterns.
 * Probe normalized text to match production behavior.
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
		console.log(`       span-but-no-key: ${stringifyJSON(missed.slice(0, 6))}`)
	}
}
