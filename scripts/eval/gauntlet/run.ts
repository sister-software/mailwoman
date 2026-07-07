/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE Gauntlet gate — runs all three layers and emits one combined verdict, so a model ship gates on the
 *   full-pipeline integration net, not just per-tag F1 (the whole point of building it; #566 lesson). Each
 *   layer runs in its own process (isolated failure, clean exit code):
 *
 *     1. regression  — the curated executable bug log; a fixed bug must STAY fixed (gated on status=pass).
 *     2. metamorphic — un-gameable INV/DIR relations; surface-form robustness (gated minus tracked xfails).
 *     3. held-out    — candidate-vs-prod z-test on a fresh draw; THE generalization gate (only with --candidate).
 *
 *   Self-check (shipped default):  node scripts/eval/gauntlet/run.ts
 *   Promote gate (a candidate):    node scripts/eval/gauntlet/run.ts --candidate ./out/v195/model.onnx [--source us]
 *
 *   Wire into the release flow as a `before:release` gate (RELEASING.md): a non-zero exit blocks the ship.
 */

import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"

// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { candidate: { type: "string" }, source: { type: "string" } },
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { candidate?: string; source?: string }
const candidate = values["candidate"] || ""
const source = values["source"] || "fr"
const modelArgs = candidate ? ["--model", candidate] : []

interface Layer {
	name: string
	argv: string[]
}
const layers: Layer[] = [
	{ name: "regression", argv: ["scripts/eval/gauntlet/regression.ts", ...modelArgs] },
	{ name: "metamorphic", argv: ["scripts/eval/gauntlet/metamorphic.ts", ...modelArgs] },
]

// The held-out layer is candidate-vs-prod — it only runs when a candidate model is supplied.
if (candidate) {
	layers.push({
		name: "held-out",
		argv: ["scripts/eval/gauntlet/holdout.ts", "--candidate", candidate, "--source", source],
	})
} else {
	console.log("[gauntlet] no --candidate → skipping the held-out generalization layer (self-check mode)")
}

const results: Array<{ name: string; pass: boolean }> = []

for (const l of layers) {
	console.log(`\n━━━━━━━━━━━━━━━━ ${l.name} ━━━━━━━━━━━━━━━━`)
	const res = spawnSync("node", l.argv, { stdio: "inherit" })
	results.push({ name: l.name, pass: res.status === 0 })
}

const allPass = results.every((r) => r.pass)

console.log(`\n════════════════ GAUNTLET ════════════════`)

for (const r of results) {
	console.log(`  ${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name}`)
}
console.log(`\nVERDICT: ${allPass ? "PASS — clear to ship" : "FAIL — do not ship"}`)
process.exit(allPass ? 0 : 1)
