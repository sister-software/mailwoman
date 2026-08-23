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

import { buildSpawnTools } from "../spawn-tools.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { benchTool } from "./bench.ts"
import { censusTool } from "./census.ts"
import { compareTool } from "./compare.ts"
import { constraintsTool } from "./constraints.ts"
import { contractTool } from "./contract.ts"
import { coverageTool } from "./coverage.ts"
import { daemonTool } from "./daemon.ts"
import { diagnoseTool } from "./diagnose.ts"
import { diffParseTool } from "./diff-parse.ts"
import { inputsTool } from "./inputs.ts"
import { lookupTool } from "./lookup.ts"
import { minimalPairsTool } from "./minimal-pairs.ts"
import { parseCompareTool } from "./parse-compare.ts"
import { provenanceTool } from "./provenance.ts"
import { reliabilityTool } from "./reliability.ts"
import { rigTool } from "./rig.ts"
import { runTool } from "./run.ts"
import { runsTool } from "./runs.ts"
import { sourcesTool } from "./sources.ts"
import { symbolTool } from "./symbol.ts"
import { traceTool } from "./trace.ts"
import { vocabTool } from "./vocab.ts"

export type { DevTool, DevToolDeps, Provenance } from "../tool-kit.ts"

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
] as const satisfies ReadonlyArray<(deps: DevToolDeps) => DevTool>

export function buildToolTable(deps: DevToolDeps): DevTool[] {
	return [...FACTORIES.map((factory) => factory(deps)), ...buildSpawnTools(deps.registry, deps.jobs)]
}
