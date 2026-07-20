/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Composed PipelineExplorer stories against a MOCK runtime — no ONNX, no gazetteer. The `Ready`
 *   story returns a fixed parse; `Loading` shows the bundle-load state.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { makePipelineRuntime } from "../test/mocks.tsx"
import { PipelineExplorer } from "./PipelineExplorer.tsx"

const meta: Meta<typeof PipelineExplorer> = {
	title: "Pipeline/PipelineExplorer",
	component: PipelineExplorer,
	args: { defaultAddress: "350 5th Ave, New York, NY 10118" },
}

export default meta
type Story = StoryObj<typeof PipelineExplorer>

export const Ready: Story = { args: { runtime: makePipelineRuntime() } }

export const Loading: Story = {
	args: {
		runtime: makePipelineRuntime({
			ready: false,
			loading: { progress: "Downloading model…", stepLabels: ["Model", "Tokenizer", "Gazetteer"], stepIndex: 1 },
		}),
	},
}

export const WithExtras: Story = {
	args: {
		runtime: makePipelineRuntime(),
		panels: {
			extras: (result) => (
				<details>
					<summary>Raw nodes ({result.nodes.length})</summary>
					<pre>{JSON.stringify(result.nodes, null, 2)}</pre>
				</details>
			),
		},
	},
}
