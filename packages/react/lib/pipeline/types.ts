/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the pipeline (parse + resolve) explorer; the runtime is injected as a {@link PipelineRuntime},
 *   keeping onnxruntime-web, sql.js-httpvfs, and node builtins out of this package's browser graph.
 */

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

/**
 * Bundle-load progress surfaced before the runtime is `ready`.
 */
export interface PipelineLoadingState {
	progress?: string
	stepLabels: string[]
	stepIndex: number
	/**
	 * Bytes received over bytes expected for the asset being fetched right now, in [0, 1], or `null` when no
	 * download is in progress or the response declares no length; the step index cannot report this download
	 * because the model is fetched before the first step begins.
	 */
	byteFraction?: number | null
}

/**
 * The injected parse runtime, which the host implements so this package never imports the model or gazetteer.
 */
export interface PipelineRuntime {
	/**
	 * Whether the model/gazetteer bundle is ready to parse.
	 */
	ready: boolean
	/**
	 * Execute a full parse+resolve, reporting stage progress via `onStage`
	 * (0-based index into `parseStageLabels`).
	 */
	runParse: (input: string, hooks: { onStage: (stage: number) => void }) => Promise<ParseResult>
	/**
	 * Per-parse progress labels (differ by whether a gazetteer lookup is wired).
	 */
	parseStageLabels: string[]
	/**
	 * Bundle-load progress (before `ready`).
	 */
	loading?: PipelineLoadingState | null
	/**
	 * Error surfaced by the bundle load, distinct from a per-parse error.
	 */
	errorMessage?: string | null
}

/**
 * Optional host-injected panels, kept as `ReactNode` thunks so this package needs neither the host's
 * components nor their data types.
 */
export interface PipelinePanels {
	/**
	 * Rendered above the form.
	 */
	header?: ReactNode
	/**
	 * Rendered below everything.
	 */
	footer?: ReactNode
	/**
	 * Model-version selector, wired to the host's bundle state.
	 */
	versionControl?: ReactNode
	/**
	 * Backend indicator + wasm toggle.
	 */
	backendControl?: ReactNode
	/**
	 * One-line release blurb.
	 */
	releaseInfo?: ReactNode
	/**
	 * Heavy visualizers (span highlight, tree, timing, BIO, …), rendered from the result.
	 */
	extras?: (result: ParseResult) => ReactNode
	/**
	 * Rendered in place of the resolved-place panel when no place resolved (host's FailureDiagnostic).
	 */
	failure?: (result: ParseResult) => ReactNode
}
