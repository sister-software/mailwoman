import { runFragmentBoard } from "../mailwoman/eval-harness/fragment-board.ts"
for (const [label, cr] of [
	["v310", "scratchpad/v310-cache"],
	["v371-b4b3-full", "scratchpad/v371-b4b3-full-cache"],
] as const) {
	console.log(`\n########## ${label} ##########`)
	await runFragmentBoard({ weightsCacheRoot: cr })
}
