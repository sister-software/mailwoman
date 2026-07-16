import { runFragmentBoard } from "../mailwoman/eval-harness/fragment-board.ts"

for (const [label, cr] of [
	["v310", "scratchpad/v310-cache"],
	["v351-full8k", "scratchpad/v351-numsplice-cache"],
	["v352-3digit2k", "scratchpad/v352-numsplice3-cache"],
] as const) {
	console.log(`\n########## ${label} ##########`)
	await runFragmentBoard({ weightsCacheRoot: cr })
}
