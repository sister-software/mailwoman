/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `PipelineExplorer` — the composed parse+resolve tester. Drives the injected {@link PipelineRuntime}
 *   through {@link useParsePipeline}, renders the core result (kind badge, component table, resolved
 *   place, candidate picker), and slots host-supplied panels (span highlight, tree, timing, …) around
 *   it. No model/gazetteer code here — composition + a `ClientOnly` SSR boundary only.
 */

import type { ReactNode } from "react"

import { ClientOnly } from "../common/ClientOnly.tsx"
import { CopyButton } from "../common/CopyButton.tsx"
import { KindBadge } from "../common/KindBadge.tsx"
import { LoadingIndicator } from "../common/LoadingIndicator.tsx"
import { PresetChips, type Preset } from "../common/PresetChips.tsx"
import { CandidatePicker } from "./CandidatePicker.tsx"
import { ComponentTable } from "./ComponentTable.tsx"
import { buildParsePayload } from "./copy.ts"
import { PIPELINE_DEFAULT_ADDRESS, PIPELINE_PRESETS } from "./presets.ts"
import { QueryForm } from "./QueryForm.tsx"
import { ResolvedPlace } from "./ResolvedPlace.tsx"
import type { PipelinePanels, PipelineRuntime } from "./types.ts"
import { useParsePipeline } from "./useParsePipeline.ts"

export interface PipelineExplorerProps {
	/** The injected model/gazetteer runtime (the host wires this to its bundle). */
	runtime: PipelineRuntime
	/** Address to pre-fill. @default the White House */
	defaultAddress?: string
	/** Example chips. @default the built-in address presets */
	presets?: ReadonlyArray<Preset>
	/** Host-injected panels + controls (version selector, span highlight, tree, …). */
	panels?: PipelinePanels
}

interface PipelineExplorerInnerProps extends Required<Pick<PipelineExplorerProps, "runtime" | "defaultAddress">> {
	presets: ReadonlyArray<Preset>
	panels: PipelinePanels
}

function PipelineExplorerInner({ runtime, defaultAddress, presets, panels }: PipelineExplorerInnerProps): ReactNode {
	const pipeline = useParsePipeline({ runtime, defaultText: defaultAddress })
	const { text, setText, busy, parseStage, result, parseError, selectedCandidate } = pipeline

	const loading = runtime.loading
	const errorMessage = parseError ?? runtime.errorMessage ?? null

	return (
		<div className="mw-pipeline-explorer">
			{panels.header}
			{panels.releaseInfo}
			{panels.versionControl}
			{panels.backendControl}

			<QueryForm
				value={text}
				onChange={setText}
				onSubmit={pipeline.submit}
				disabled={!runtime.ready}
				busy={busy}
				placeholder={PIPELINE_DEFAULT_ADDRESS}
			/>

			<PresetChips
				presets={presets}
				disabled={!runtime.ready || busy}
				onPick={(value) => {
					setText(value)
					pipeline.reset()
				}}
			/>

			{loading && !runtime.ready ? (
				<LoadingIndicator
					mode="staged"
					steps={loading.stepLabels.length > 0 ? loading.stepLabels : undefined}
					activeStep={loading.stepIndex}
					label={loading.progress}
				/>
			) : null}
			{errorMessage ? <p className="mw-error">{errorMessage}</p> : null}

			{busy ? (
				<div className="mw-result">
					<LoadingIndicator mode="staged" steps={runtime.parseStageLabels} activeStep={parseStage} />
				</div>
			) : result ? (
				<div className="mw-result">
					<div className="mw-result__header">
						<h2>Parsed components</h2>
						<CopyButton
							value={() => buildParsePayload(result, selectedCandidate)}
							label="Copy JSON"
							copiedLabel="✓ Copied"
						/>
					</div>

					{result.kindResult ? <KindBadge kindResult={result.kindResult} /> : null}

					{panels.extras ? panels.extras(result) : null}

					<ComponentTable nodes={result.nodes} />

					{selectedCandidate ? (
						<>
							<ResolvedPlace place={selectedCandidate} dualRoles={result.dualRoles} />
							{result.candidates.length > 1 ? (
								<CandidatePicker
									candidates={result.candidates}
									selectedIndex={pipeline.selectedCandidateIndex}
									onSelect={pipeline.selectCandidate}
								/>
							) : null}
						</>
					) : panels.failure ? (
						panels.failure(result)
					) : null}
				</div>
			) : null}

			{panels.footer}
		</div>
	)
}

export function PipelineExplorer({
	runtime,
	defaultAddress = PIPELINE_DEFAULT_ADDRESS,
	presets = PIPELINE_PRESETS,
	panels = {},
}: PipelineExplorerProps): ReactNode {
	return (
		<ClientOnly
			fallback={
				<div className="mw-pipeline-explorer">
					<p>Loading demo embed…</p>
				</div>
			}
		>
			{() => (
				<PipelineExplorerInner runtime={runtime} defaultAddress={defaultAddress} presets={presets} panels={panels} />
			)}
		</ClientOnly>
	)
}
