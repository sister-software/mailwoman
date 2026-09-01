/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The tool table — the tested contract. `server.ts` only adapts it to the SDK's envelope.
 *
 *   ONE FILE PER TOOL, and the split is along the seam that matters: a file here is a CONTRACT — the description an
 *   agent reads, the input schema, the handler wiring — while the measurement it calls lives in the package root
 *   (`compare.ts`, `diagnose.ts`, `provenance.ts`, `vocabulary.ts`, …). The pairing is deliberate rather than
 *   duplicated naming: `tools/diagnose.ts` is what an agent is told `mwdev_diagnose` does, `../diagnose.ts` is what it
 *   actually does, and the two change for different reasons. A description is not documentation here — it is the only
 *   thing standing between a tool and being used for the wrong question, which is why they are long.
 *
 *   Four tools that spawn the compiled CLI live in `../spawn-tools.ts` and are appended below.
 *
 *   Two rules bind every result:
 *
 *   1. **A number never travels without its denominator.** `n_requested`, `n_evaluated`, `n_errored` are mandatory, and
 *      the confidence bound lives inside `summary` — the sentence an agent relays — rather than in a field it can drop.
 *   2. **Absence is reported as absence.** A stage that produced nothing says so and says why; nothing here fills in a
 *      value the pipeline did not produce.
 */

import { buildSpawnTools } from "#spawn-tools"
import type { DevTool, DevToolDeps } from "#tool-kit"
import { arcTool } from "#tools/arc"
import { benchTool } from "#tools/bench"
import { censusTool } from "#tools/census"
import { compareTool } from "#tools/compare"
import { constraintsTool } from "#tools/constraints"
import { contractTool } from "#tools/contract"
import { coverageTool } from "#tools/coverage"
import { daemonTool } from "#tools/daemon"
import { diagnoseTool } from "#tools/diagnose"
import { diffParseTool } from "#tools/diff-parse"
import { inputsTool } from "#tools/inputs"
import { lookupTool } from "#tools/lookup"
import { minimalPairsTool } from "#tools/minimal-pairs"
import { parseCompareTool } from "#tools/parse-compare"
import { provenanceTool } from "#tools/provenance"
import { reliabilityTool } from "#tools/reliability"
import { rigTool } from "#tools/rig"
import { runTool } from "#tools/run"
import { runsTool } from "#tools/runs"
import { sourcesTool } from "#tools/sources"
import { symbolTool } from "#tools/symbol"
import { traceTool } from "#tools/trace"
import { vocabTool } from "#tools/vocab"

export type { DevTool, DevToolDeps, Provenance } from "#tool-kit"

/**
 * Every tool, in the order an agent should meet them: what is running, what can be measured, the measurements
 * themselves, then the surfaces that explain a result.
 */
const FACTORIES = [
	daemonTool,
	inputsTool,
	lookupTool,
	runTool,
	compareTool,
	arcTool,
	parseCompareTool,
	traceTool,
	benchTool,
	censusTool,
	constraintsTool,
	contractTool,
	diagnoseTool,
	minimalPairsTool,
	reliabilityTool,
	rigTool,
	provenanceTool,
	coverageTool,
	diffParseTool,
	sourcesTool,
	symbolTool,
	vocabTool,
	runsTool,
] as const satisfies ReadonlyArray<(deps: DevToolDeps) => DevTool | Promise<DevTool>>

export async function buildToolTable(deps: DevToolDeps): Promise<DevTool[]> {
	return [
		...(await Promise.all(FACTORIES.map((factory) => factory(deps)))),
		...(await buildSpawnTools(deps.registry, deps.jobs)),
	]
}
