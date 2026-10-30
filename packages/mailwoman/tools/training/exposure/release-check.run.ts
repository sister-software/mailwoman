/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs one stage of the release-time exposure check on an exposure report, prints the findings as JSON, and exits 1
 *   when the check refuses.
 *
 *   `preflight` reads the `replayed_draws` stage. `completed` reads `realized_draws` and the floors in `floors.json`.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/exposure/release-check.run.ts preflight --report exposure.json \
 *       --claim RU:streetless-premise-identity [--epochs 8]
 *     node packages/mailwoman/tools/training/exposure/release-check.run.ts completed \
 *       --report exposure-realized-from-0.json --claim … [--contrast-failure <id> …]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { orderedJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { claimFromArgument, completedRun, type ExposureForms, loadFloors, preflight, refused } from "./release-check.ts"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		report: { type: "string" },
		claim: { type: "string", multiple: true, default: [] },
		epochs: { type: "string", default: "1" },
		"contrast-failure": { type: "string", multiple: true, default: [] },
	},
})

const [stage] = positionals

if (stage !== "preflight" && stage !== "completed") throw new Error("expected the stage: preflight or completed")

if (!values.report) throw new Error("--report is required")

const epochs = Number(values.epochs)

if (!Number.isInteger(epochs)) throw new Error(`--epochs expects an integer, got ${values.epochs}`)

const report = await readLocalJSONFile<ExposureForms>(values.report)
const claims = values.claim.map(claimFromArgument)

const findings =
	stage === "preflight"
		? preflight(report, claims, epochs)
		: completedRun(report, claims, await loadFloors(), values["contrast-failure"])

console.log(orderedJSON(findings, { indent: "\t" }))

process.exitCode = refused(findings) ? 1 : 0
