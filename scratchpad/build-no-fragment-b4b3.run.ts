import { writeFileSync } from "node:fs"

import { noFragmentRecipe } from "../corpus/src/shard-recipes/no-fragment.ts"

// B4b knob 3: bare-street back to 0.30 (the lever is NOT bare-street), long-number-boost 4x on
// street+number rows whose number has >=3 digits — oversample the exact failing class
// (Leppdalsvegen 1285 -> postcode) to fight the tokenizer length prior with volume.
const klassCount = new Map<string, number>()
const digitBuckets = new Map<string, number>()
const lines: string[] = []
const stats = await noFragmentRecipe.run(
	{
		output: "",
		seed: 901,
		variants: 1,
		bareProb: 0.3,
		longNumberBoost: 4,
		longNumberMinDigits: 3,
		input: "/mnt/playpen/mailwoman-data/corpus/tuples/no-boundary-tuples.jsonl",
		excludeSurfaces: "mailwoman/eval-harness/fixtures/no-digits.surfaces.txt",
	},
	(line) => {
		lines.push(line)
		try {
			const r = JSON.parse(line)
			const num = r.components?.house_number
			const hasLoc = r.components?.locality
			const hasPc = r.components?.postcode
			const k = num ? "street-hn" : hasLoc ? "counter-bare-locality" : hasPc ? "counter-bare-postcode" : "bare-street"
			klassCount.set(k, (klassCount.get(k) ?? 0) + 1)
			if (num) {
				const d = (String(num).match(/\d/g) ?? []).length
				const b = d >= 3 ? "hn>=3digit" : "hn<3digit"
				digitBuckets.set(b, (digitBuckets.get(b) ?? 0) + 1)
			}
		} catch {}
	}
)
writeFileSync("/tmp/no-fragment.jsonl", lines.join(""))
console.log("no-fragment b4b-knob3 shard:", JSON.stringify(stats), "->", lines.length, "rows")
console.log("composition:", JSON.stringify(Object.fromEntries([...klassCount].sort())))
console.log("street-hn digit split:", JSON.stringify(Object.fromEntries([...digitBuckets].sort())))
