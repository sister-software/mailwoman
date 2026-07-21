/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<ResultPanel>` over a fake parse result — the resolved case (component table + resolved place +
 *   candidate picker, switchable) and the no-resolve case (the injected `failure` slot). Reuses the shared
 *   pipeline units; no maplibre.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { makeFakeParseResult } from "../test/mocks.tsx"
import { ResultPanel } from "./ResultPanel.tsx"

const meta: Meta<typeof ResultPanel> = {
	title: "Map/Panels/ResultPanel",
	component: ResultPanel,
	decorators: [(Story) => <div className="mw-pipeline-explorer">{Story()}</div>],
}
export default meta
type Story = StoryObj<typeof ResultPanel>

/** A resolved result — click an alternate candidate to update the resolved-place detail. */
export const WithResolved: Story = {
	render: () => {
		const [index, setIndex] = useState(0)
		const result = makeFakeParseResult()

		return (
			<ResultPanel
				result={result}
				selectedCandidate={result.candidates[index] ?? null}
				selectedCandidateIndex={index}
				onSelectCandidate={setIndex}
			/>
		)
	},
}

/** No candidates → the injected `failure` slot renders instead of a resolved place. */
export const Failure: Story = {
	render: () => {
		const result = { ...makeFakeParseResult(), resolved: null, candidates: [] }

		return (
			<ResultPanel
				result={result}
				selectedCandidate={null}
				selectedCandidateIndex={0}
				onSelectCandidate={() => {}}
				failure={() => <p className="mw-muted">Nothing resolved — check the parsed components above.</p>}
			/>
		)
	},
}
