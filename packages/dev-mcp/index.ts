/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Public surface of the maintainer-only development MCP server.
 */

export { EngineRegistry, resolveConfig, engineID, type EngineConfig, type Engine } from "./engine-registry.ts"
export { assembleBench, summarizeLatency, CONCURRENCY_NOTE, type BenchReading, type LatencyReading } from "./bench.ts"

export { checkCLIAllowlist, type AllowlistVerdict } from "./cli-allowlist.ts"

export { assertCompiledFresh, checkCompiledFreshness, type CompiledFreshness } from "./compiled-tree.ts"

export {
	lookupFST,
	lookupNormalize,
	lookupStreetMorphology,
	loadFSTArtifact,
	LookupSource,
	type LookupRow,
} from "./lookup.ts"

export { readGateReport, summarizeGateReport, LEDGER_NOTE, type GateReport, type FloorReading } from "./gate-report.ts"
export { parseGauntletReport, summarizeGauntletReport, type GauntletReport } from "./gauntlet-report.ts"
export { JobRegistry, type Job, type JobSummary, type JobState } from "./jobs.ts"
export { checkConfounds, VariableIsolation, assertComparableField, type ConfoundReading } from "./confound.ts"
export { gradeRow, significance, seedToCaseTable, caseCarriesTruth, type RowGrade } from "./grade.ts"
export { resolveInputSet, type InputSetRef, type ResolvedInputSet } from "./input-sets.ts"
export { describeObservedRate, wilsonInterval, zeroEventUpperBound, type PowerReading } from "./power.ts"
export { computeTreeFingerprint, staleEngineMessage, type TreeFingerprint } from "./tree-fingerprint.ts"
export { buildToolTable, type DevTool, type DevToolDeps, type Provenance } from "./tools.ts"
export { createDevMCPServer } from "./server.ts"
