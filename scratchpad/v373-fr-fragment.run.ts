import { runFragmentBoard } from "../mailwoman/eval-harness/fragment-board.ts"
for (const [label, cr] of [
	["v310", "scratchpad/v310-cache"],
	["v373-tweak-full", "scratchpad/v373-tweak-full-cache"],
] as const) {
	console.log(`\n########## ${label} ##########`)
	await runFragmentBoard({ weightsCacheRoot: cr })
}
