/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Public surface of the maintainer-only development MCP server.
 */

export { EngineRegistry, resolveConfig, engineID, type EngineConfig, type Engine } from "#engine-registry"
export { assembleBench, summarizeLatency, CONCURRENCY_NOTE, type BenchReading, type LatencyReading } from "#bench"

export { checkCLIAllowlist, type AllowlistVerdict } from "#cli-allowlist"

export { assertCompiledFresh, checkCompiledFreshness, type CompiledFreshness } from "#compiled-tree"

export {
	lookupFST,
	lookupNormalize,
	lookupStreetMorphology,
	loadFSTArtifact,
	LookupSource,
	type LookupRow,
} from "#lookup"

export { readEvalReport, summarizeEvalReport, LEDGER_NOTE, type EvalReport, type FloorReading } from "#eval-report"
export { parseGauntletReport, summarizeGauntletReport, type GauntletReport } from "#gauntlet-report"
export { JobRegistry, type Job, type JobSummary, type JobState } from "#jobs"
export { checkConfounds, VariableIsolation, assertComparableField, type ConfoundReading } from "#confound"

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
} from "#diagnose"

export {
	enumerateFlips,
	measureMove,
	runCounterfactuals,
	COUNTERFACTUAL_LEVERS,
	type CounterfactualLever,
	type RowCounterfactuals,
} from "#counterfactual"

export { gradeRow, significance, seedToCaseTable, caseCarriesTruth, type RowGrade } from "#grade"
export { resolveInputSet, type InputSetRef, type ResolvedInputSet } from "#input-sets"
export { describeObservedRate, wilsonInterval, zeroEventUpperBound, type PowerReading } from "#power"
export { computeTreeFingerprint, staleEngineMessage, type TreeFingerprint } from "#tree-fingerprint"
export { buildToolTable, type DevTool, type DevToolDeps, type Provenance } from "#tools/index"
export { createDevMCPServer } from "#server"
