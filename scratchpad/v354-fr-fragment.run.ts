import { runFragmentBoard } from "../mailwoman/eval-harness/fragment-board.ts"
for (const [label, cr] of [
	["v310", "scratchpad/v310-cache"],
	["v352-3digit-2k", "scratchpad/v352-numsplice3-cache"],
	["v354-3digit-8k", "scratchpad/v354-numsplice3-full-cache"],
] as const) {
	console.log(`\n########## ${label} ##########`)
	await runFragmentBoard({ weightsCacheRoot: cr })
}
