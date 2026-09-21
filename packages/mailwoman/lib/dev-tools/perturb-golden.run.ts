/**
 * Perturb-golden.ts — corpus-perturbation neutral-arena generator (Direction A).
 *
 * Our 376-assertion suite is a Pelias/addressit port (v0's lineage),
 * so it can't reveal where neural beats rules.
 * This builds an unbiased arena from ground truth WE own: take golden v0.1.2 (already labeled in our schema)
 * and apply rule- defeating perturbations while keeping the component labels intact.
 *
 * Rule-based parsers lean on delimiters / capitalization / canonical spacing.
 * A contextual neural model should degrade more gracefully.
 *
 * The three-bucket harness then shows whether that's true (the methodology-vindication test).
 *
 * Perturbation classes (each preserves the expected components — only the surface changes,
 * and the harness matcher normalizes case + allows substring):
 *
 * - Delimiter-strip : remove commas (rules depend on them)
 * - Lowercase : drop capitalization cues
 * - Glue : collapse the space between region and postcode ("OR97214")
 *
 * Run: node packages/mailwoman/lib/dev-tools/perturb-golden.run.ts\ --golden
 * data/eval/golden/v0.1.2 --out /tmp/perturb-eval/perturbed.jsonl [--per-file 60]
 * Then run it through harness-neural (formerly harness-v0-neural with --symmetric-match).
 */

import { tempRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { dirname, join } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { OVERLAY_LOCALE_BY_COUNTRY } from "#eval-harness/gauntlet/routing"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArguments({
	options: { golden: { type: "string" }, out: { type: "string" }, "per-file": { type: "string" } },
	strict: false,
	allowPositionals: true,
})

// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { golden?: string; out?: string; "per-file"?: string }
const GOLDEN = values["golden"] || "data/eval/golden/v0.1.2"
const OUT = values["out"] || tempRootPath("perturb-eval", "perturbed.jsonl")
const PER_FILE = Number(values["per-file"] || "60")

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country?: string
	locale?: string
}

/**
 * Collapse the whitespace between the region and the postcode where the row writes them adjacently —
 * `or 97214` → `OR97214`, `Auvergne-Rhône-Alpes 69001` → `Auvergne-Rhône-Alpes69001`.
 *
 * Driven by the row's own components rather than by a shape.
 * `\b([A-Z]{2})\s+(\d{5})\b` matches a US region code and a five-digit ZIP
 * and nothing else, so it read every non-US row as unperturbable — and this tool
 * runs over the whole golden directory, `fr.jsonl` included.
 *
 * A country whose layout writes the postcode first, or writes no region, still produces
 * no change here, and the caller counts that rather than emitting the row unperturbed.
 */
function glue(raw: string, components: Record<string, string>): string {
	const region = components.region?.trim()
	const postcode = components.postcode?.trim()

	if (!region || !postcode) return raw

	return raw.replaceAll(`${region} ${postcode}`, `${region}${postcode}`)
}

const PERTURBATIONS: Array<{ name: string; apply: (raw: string, components: Record<string, string>) => string }> = [
	{ name: "delimiter-strip", apply: (r) => r.replaceAll(",", "") },
	{ name: "lowercase", apply: (r) => r.toLowerCase() },
	{ name: "glue", apply: glue },
]

async function main(): Promise<void> {
	await makeDirectories(dirname(OUT))
	const out: string[] = []

	/**
	 * Per class: cases written, and rows the class could not change.
	 *
	 * A class that covers one country reports a large unperturbed count here
	 * rather than looking like a class that simply produced fewer cases.
	 */
	const emitted = new Map<string, number>()
	const unperturbed = new Map<string, number>()

	let base = 0

	for await (const file of Globerator.files("jsonl", { cwd: GOLDEN, absolute: false, recursive: false })) {
		// The stride below needs the row count before it can pick a row, then indexes them, so the whole
		// set has to be resident either way — streaming would only move the materialization.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- see above
		const lines = (await readLocalTextFile(join(GOLDEN, file))).split("\n").filter((l) => l.trim())

		// Deterministic spread: every Nth row up to PER_FILE.
		const step = Math.max(1, Math.floor(lines.length / PER_FILE))

		for (let i = 0; i < lines.length && out.length / PERTURBATIONS.length < base + PER_FILE; i += step) {
			const row = tryParsingJSON<GoldenRow>(lines[i]!)

			if (!row?.raw || !row.components) continue
			// Expected = the golden components, wrapped as {tag: [value]} (harness format).
			const expected: Record<string, string[]> = {}

			for (const [tag, val] of Object.entries(row.components))
				if (val) {
					expected[tag] = [val]
				}

			if (!Object.keys(expected).length) continue

			for (const p of PERTURBATIONS) {
				const input = p.apply(row.raw, row.components)

				// A perturbation that changed nothing is not a case.
				// `lowercase` is the exception: a row already lowercase is still a lowercase case,
				// and the register leg exists to be graded on every row.
				if (input === row.raw && p.name !== "lowercase") {
					unperturbed.set(p.name, (unperturbed.get(p.name) ?? 0) + 1)

					continue
				}

				out.push(
					stringifyJSON({
						input,
						locale: row.locale ?? OVERLAY_LOCALE_BY_COUNTRY[(row.country ?? "").toUpperCase()] ?? "en-US",
						expected,
						perturb_class: p.name,
						source: `perturb/${file}`,
					})
				)

				emitted.set(p.name, (emitted.get(p.name) ?? 0) + 1)
			}
		}

		base += PER_FILE
	}

	await writeLocalTextFile(out, OUT)

	console.log(`wrote ${out.length} perturbed cases → ${OUT}\n`)
	console.log(`| class | cases | rows it could not change |`)
	console.log(`| --- | --: | --: |`)

	for (const p of PERTURBATIONS) {
		console.log(`| ${p.name} | ${emitted.get(p.name) ?? 0} | ${unperturbed.get(p.name) ?? 0} |`)
	}
}

await main()
