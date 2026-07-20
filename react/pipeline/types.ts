/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the pipeline (parse + resolve) explorer. The model/gazetteer runtime is INJECTED as a
 *   {@link PipelineRuntime}: this package owns the UI state machine + presentation, while the host
 *   (the docs site's DemoEmbed, or any app) owns loading ONNX/WOF and executing a parse. That keeps
 *   onnxruntime-web, sql.js-httpvfs, and node builtins entirely out of this package's browser graph.
 */

import type { ReactNode } from "react"

import type { KindBadgeResult } from "../common/KindBadge.tsx"

/** One decoded component, as the table + span views render it. Offsets index into `ParseResult.input`. */
export interface ParsedComponent {
	tag: string
	value?: unknown
	confidence?: number
	start?: number
	end?: number
}

/** A resolved gazetteer place, projected to what the "Resolved place" panel + copy payload need. */
export interface ResolvedPlaceView {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
	score: number
}

/** An additional admin role a resolved place also fulfils (the dual-role / city-state relation, #402). */
export interface DualRoleView {
	id: number
	name: string
	placetype: string
	relationshipType: string
	role: string
}

/** Per-stage wall-clock (ms) for one parse. `resolve` is absent when the lookup is skipped. */
export interface StageTiming {
	shape: number
	classify: number
	resolve?: number
}

/** FST gazetteer-prior provenance, as the "FST prior" disclosure renders it. */
export interface FSTProvenance {
	builtAt: string
	stateCount: number
	placeCount: number
	importanceMatches: number
}

/** The presentational projection of one parse+resolve. The host's `runParse` produces it. */
export interface ParseResult {
	input: string
	/** Opaque hierarchy — handed straight to a host-injected tree/visualizer panel. */
	tree: unknown
	nodes: ParsedComponent[]
	kindResult?: KindBadgeResult
	timing?: StageTiming
	resolved: ResolvedPlaceView | null
	candidates: ResolvedPlaceView[]
	fstActive: boolean
	fstProvenance?: FSTProvenance | null
	dualRoles?: DualRoleView[]
}

/** Bundle-load progress surfaced before the runtime is `ready`. */
export interface PipelineLoadingState {
	progress?: string
	stepLabels: string[]
	stepIndex: number
}

/**
 * The injected parse runtime. The host implements `runParse` (compute shape → classify → resolve) and reports load
 * progress + errors. This package never imports the model or gazetteer — it only calls this contract.
 */
export interface PipelineRuntime {
	/** Whether the model/gazetteer bundle is ready to parse. */
	ready: boolean
	/** Execute a full parse+resolve, reporting stage progress via `onStage` (0-based index into `parseStageLabels`). */
	runParse: (input: string, hooks: { onStage: (stage: number) => void }) => Promise<ParseResult>
	/** Per-parse progress labels (differ by whether a gazetteer lookup is wired). */
	parseStageLabels: string[]
	/** Bundle-load progress (before `ready`). */
	loading?: PipelineLoadingState | null
	/** Error surfaced by the bundle load, distinct from a per-parse error. */
	errorMessage?: string | null
}

/**
 * Optional host-injected panels. Each is a function of the current parse result returning already-rendered content (the
 * docs site's SpanHighlight, TreeView, TimingPanel, …). Kept as `ReactNode` thunks so this package needs neither those
 * components nor their heavy data types.
 */
export interface PipelinePanels {
	/** Rendered above the form (e.g. the docs "About this demo"). */
	header?: ReactNode
	/** Rendered below everything (e.g. a guided tour). */
	footer?: ReactNode
	/** Model-version selector, wired to the host's bundle state. */
	versionControl?: ReactNode
	/** Backend indicator + WASM toggle. */
	backendControl?: ReactNode
	/** One-line release blurb. */
	releaseInfo?: ReactNode
	/** Heavy visualizers (span highlight, tree, timing, BIO, …), rendered from the result. */
	extras?: (result: ParseResult) => ReactNode
	/** Rendered in place of the resolved-place panel when nothing resolved (host's FailureDiagnostic). */
	failure?: (result: ParseResult) => ReactNode
}
