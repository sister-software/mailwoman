import { runFragmentBoard } from "../mailwoman/eval-harness/fragment-board.ts"
for (const [label, cr] of [
	["v310", "scratchpad/v310-cache"],
	["v352-3digit", "scratchpad/v352-numsplice3-cache"],
	["v353-10to999", "scratchpad/v353-numsplice23-cache"],
] as const) {
	console.log(`\n########## ${label} ##########`)
	await runFragmentBoard({ weightsCacheRoot: cr })
}
