import { runFragmentBoard } from "../mailwoman/eval-harness/fragment-board.ts"
for (const [label, cr] of [
	["v310", "scratchpad/v310-cache"],
	["v360-b4b", "scratchpad/v360-b4b-cache"],
] as const) {
	console.log(`\n########## ${label} ##########`)
	await runFragmentBoard({ weightsCacheRoot: cr })
}
