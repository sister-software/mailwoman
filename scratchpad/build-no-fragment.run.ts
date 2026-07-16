import { writeFileSync } from "node:fs"

import { noFragmentRecipe } from "../corpus/src/shard-recipes/no-fragment.ts"

const lines: string[] = []
const stats = await noFragmentRecipe.run(
	{
		output: "",
		seed: 901,
		variants: 1,
		input: "/mnt/playpen/mailwoman-data/corpus/tuples/no-boundary-tuples.jsonl",
		excludeSurfaces: "mailwoman/eval-harness/fixtures/no-digits.surfaces.txt",
	},
	(line) => lines.push(line)
)
writeFileSync("scratchpad/no-fragment-sample.jsonl", lines.join("\n") + "\n")
console.log("stats:", JSON.stringify(stats))
// class census + the first few rows of each
const byK: Record<string, number> = {}
const sample: Record<string, string> = {}
for (const l of lines) {
	const r = JSON.parse(l)
	const k =
		r.synth_method === "no-fragment"
			? r.components?.house_number
				? String(r.components.house_number).includes("/")
					? "slash-hn"
					: "street-hn"
				: r.components?.street
					? "bare-street"
					: r.components?.locality
						? "counter-loc"
						: "counter-pc"
			: "?"
	byK[k] = (byK[k] ?? 0) + 1
	if (!sample[k]) sample[k] = r.raw
}
console.log("class census:", JSON.stringify(byK, null, 0))
console.log("samples:")
for (const [k, v] of Object.entries(sample)) console.log(`  ${k.padEnd(14)} ${JSON.stringify(v)}`)
