/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The tool table — the tested interface; `server.ts` only adapts it to the SDK's envelope.
 *
 * Two rules bind every result: a number never travels without its denominator. Absence is reported as absence — no
 * line here fills in a value the pipeline did not produce.
 */

import { buildSpawnTools } from "#dev-mcp/spawn-tools"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"
import { arcTool } from "#dev-mcp/tools/arc"
import { benchTool } from "#dev-mcp/tools/bench"
import { censusTool } from "#dev-mcp/tools/census"
import { compareTool } from "#dev-mcp/tools/compare"
import { constraintsTool } from "#dev-mcp/tools/constraints"
import { coverageTool } from "#dev-mcp/tools/coverage"
import { daemonTool } from "#dev-mcp/tools/daemon"
import { diagnoseTool } from "#dev-mcp/tools/diagnose"
import { diffGeocodeTool } from "#dev-mcp/tools/diff/geocode"
import { diffParseTool } from "#dev-mcp/tools/diff/parse"
import { githubTools } from "#dev-mcp/tools/github"
import { inputsTool } from "#dev-mcp/tools/inputs"
import { interfaceTool } from "#dev-mcp/tools/interface"
import { lookupTool } from "#dev-mcp/tools/lookup"
import { minimalPairsTool } from "#dev-mcp/tools/minimal-pairs"
import { parseCompareTool } from "#dev-mcp/tools/parse-compare"
import { provenanceTool } from "#dev-mcp/tools/provenance"
import { reliabilityTool } from "#dev-mcp/tools/reliability"
import { rigTool } from "#dev-mcp/tools/rig"
import { runTool } from "#dev-mcp/tools/run"
import { runsTool } from "#dev-mcp/tools/runs"
import { sourcesTool } from "#dev-mcp/tools/sources"
import { symbolTool } from "#dev-mcp/tools/symbol"
import { traceTool } from "#dev-mcp/tools/trace"
import { vocabTool } from "#dev-mcp/tools/vocab"

export type { DevTool, DevToolDeps, Provenance } from "#dev-mcp/tool-kit"
export { githubTools } from "#dev-mcp/tools/github"

/**
 * Every tool, in the order an agent should meet them: what is running, what can be measured,
 * the measurements themselves, then the surfaces that explain a result.
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
	interfaceTool,
	diagnoseTool,
	minimalPairsTool,
	reliabilityTool,
	rigTool,
	provenanceTool,
	coverageTool,
	diffParseTool,
	diffGeocodeTool,
	sourcesTool,
	symbolTool,
	vocabTool,
	runsTool,
] as const satisfies ReadonlyArray<(deps: DevToolDeps) => DevTool | Promise<DevTool>>

/**
 * Build every registered tool, in the order an agent should meet them.
 */
export async function buildToolTable(deps: DevToolDeps): Promise<DevTool[]> {
	return [
		...(await Promise.all(FACTORIES.map((factory) => factory(deps)))),
		...githubTools(deps),
		...(await buildSpawnTools(deps.registry, deps.jobs)),
	]
}
