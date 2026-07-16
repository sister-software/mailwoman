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
writeFileSync("/tmp/no-fragment.jsonl", lines.join(""))
console.log("no-fragment shard:", JSON.stringify(stats), "->", lines.length, "rows -> /tmp/no-fragment.jsonl")
