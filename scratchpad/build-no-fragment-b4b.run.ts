import { writeFileSync } from "node:fs"

import { noFragmentRecipe } from "../corpus/src/shard-recipes/no-fragment.ts"

// B4b knob 1: bare-street ratio 0.30 -> 0.70. The v3.3.0 probe spent 70% of signal on {street}{number}
// (a form the model mostly handles); this concentrates the signal on the pure bare-street licence
// (street WITHOUT a number) so the model learns street != locality and can't lean on the digit.
const klassCount = new Map<string, number>()
const lines: string[] = []
const stats = await noFragmentRecipe.run(
	{
		output: "",
		seed: 901,
		variants: 1,
		bareProb: 0.7,
		input: "/mnt/playpen/mailwoman-data/corpus/tuples/no-boundary-tuples.jsonl",
		excludeSurfaces: "mailwoman/eval-harness/fixtures/no-digits.surfaces.txt",
	},
	(line) => {
		lines.push(line)
		try {
			const r = JSON.parse(line)
			const hasNum = r.components?.house_number
			const hasLoc = r.components?.locality
			const hasPc = r.components?.postcode
			const k = hasNum
				? "street-hn"
				: hasLoc
					? "counter-bare-locality"
					: hasPc
						? "counter-bare-postcode"
						: "bare-street"
			klassCount.set(k, (klassCount.get(k) ?? 0) + 1)
		} catch {}
	}
)
writeFileSync("/tmp/no-fragment.jsonl", lines.join(""))
console.log("no-fragment b4b shard:", JSON.stringify(stats), "->", lines.length, "rows")
console.log("composition:", JSON.stringify(Object.fromEntries([...klassCount].sort())))
