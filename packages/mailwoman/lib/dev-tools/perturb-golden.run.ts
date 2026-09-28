import { tempRootPathBuilder } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { OVERLAY_LOCALE_BY_COUNTRY } from "#eval-harness/gauntlet/routing"

const { values: rawValues } = parseArguments({
	options: { golden: { type: "string" }, out: { type: "string" }, "per-file": { type: "string" } },
	allowPositionals: true,
})

const values = rawValues as { golden?: string; out?: string; "per-file"?: string }
const GOLDEN = PathBuilder.from(values["golden"] || "data/eval/golden/v0.1.2")
const OUT = PathBuilder.from(values["out"] || tempRootPathBuilder("perturb-eval", "perturbed.jsonl"))
const PER_FILE = Number(values["per-file"] || "60")

interface GoldenRow {
	raw: string
	components: Record<string, string>
	country?: string
	locale?: string
}

/**
 * Collapse the whitespace between the region and the postcode where the row writes
 * them adjacently, driven by the row's own components rather than by a shape:
 * a country whose layout writes the postcode first or writes no region produces no change,
 * and the caller counts that rather than emitting the row unperturbed.
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
	await makeDirectories(OUT.dirname())
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
		// The stride needs the row count before it can pick a row, so the read stays resident either way.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- see above
		const lines = (await readLocalTextFile(GOLDEN(file))).split("\n").filter((l) => l.trim())

		const step = Math.max(1, Math.floor(lines.length / PER_FILE))

		for (let i = 0; i < lines.length && out.length / PERTURBATIONS.length < base + PER_FILE; i += step) {
			const row = tryParsingJSON<GoldenRow>(lines[i]!)

			if (!row?.raw || !row.components) continue
			// Expected is the golden components wrapped as { tag: [value] }, the harness's format.
			const expected: Record<string, string[]> = {}

			for (const [tag, val] of Object.entries(row.components))
				if (val) {
					expected[tag] = [val]
				}

			if (!Object.keys(expected).length) continue

			for (const p of PERTURBATIONS) {
				const input = p.apply(row.raw, row.components)

				// A perturbation that changed no value is not a case, except `lowercase`,
				// whose register leg is graded on every row.
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
