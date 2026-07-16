import { runFragmentBoard } from "../mailwoman/eval-harness/fragment-board.ts"
for (const [label, cr] of [
	["v310", "scratchpad/v310-cache"],
	["v372-tweak", "scratchpad/v372-tweak-cache"],
] as const) {
	console.log(`\n########## ${label} ##########`)
	await runFragmentBoard({ weightsCacheRoot: cr })
}
