/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Public surface of the maintainer-only development MCP server.
 */

export { EngineRegistry, resolveConfig, engineID, type EngineConfig, type Engine } from "#dev-mcp/engine/registry"

export {
	assembleBench,
	summarizeLatency,
	CONCURRENCY_NOTE,
	type BenchReading,
	type LatencyReading,
} from "#dev-mcp/bench"

export { checkCLIAllowlist, type AllowlistVerdict } from "#dev-mcp/cli/allowlist"

// `CompiledFreshness` is declared by `@mailwoman/core/module/compiled-freshness`
// and a consumer imports it from there: one public home per declaration,
// so a reader can tell from the specifier which package owns the type.
export { assertCompiledFresh, checkSpawnedTreeFreshness } from "#dev-mcp/compiled-tree"

export {
	lookupFST,
	lookupNormalize,
	lookupStreetMorphology,
	loadFSTArtifact,
	LookupSource,
	type LookupRow,
} from "#dev-mcp/lookup"

export {
	readEvalReport,
	summarizeEvalReport,
	LEDGER_NOTE,
	type EvalReport,
	type FloorReading,
} from "#dev-mcp/eval-report"

export { parseGauntletReport, summarizeGauntletReport, type GauntletReport } from "#dev-mcp/gauntlet-report"
export { JobRegistry, type Job, type JobSummary, type JobState } from "#dev-mcp/jobs"
export { checkConfounds, VariableIsolation, assertComparableField, type ConfoundReading } from "#dev-mcp/confound"

export {
	aggregateByShape,
	aggregateCounterfactuals,
	assembleAccount,
	matchShapes,
	renderAccount,
	runDiagnose,
	DIAGNOSE_SHAPES,
	SHAPE_PREDICATES,
	type DiagnoseShape,
	type RowAccount,
} from "#dev-mcp/diagnose"

export {
	enumerateFlips,
	measureMove,
	runCounterfactuals,
	COUNTERFACTUAL_SETTINGS,
	type CounterfactualSetting,
	type RowCounterfactuals,
} from "#dev-mcp/counterfactual"

export { gradeRow, significance, seedToCaseTable, caseCarriesTruth, type RowGrade } from "#dev-mcp/grade"
export { resolveInputSet, type InputSetRef, type ResolvedInputSet } from "#dev-mcp/input-sets"
export { describeObservedRate, wilsonInterval, zeroEventUpperBound, type PowerReading } from "#dev-mcp/power"
export { computeTreeFingerprint, staleEngineMessage, type TreeFingerprint } from "#dev-mcp/tree-fingerprint"
export { buildToolTable, type DevTool, type DevToolDeps, type Provenance } from "#dev-mcp/tools"
export { createDevMCPServer } from "#dev-mcp/server"
