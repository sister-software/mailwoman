/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { prettyJSON } from "@mailwoman/core/json"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { makePipelineRuntime } from "#map/fake-runtime"

import { PipelineExplorer } from "./PipelineExplorer.tsx"

/**
 * Stories for `PipelineExplorer` against a mock runtime that loads neither a model nor a gazetteer.
 */
const meta: Meta<typeof PipelineExplorer> = {
	title: "Pipeline/PipelineExplorer",
	component: PipelineExplorer,
	args: { defaultAddress: "350 5th Ave, New York, NY 10118" },
}

export default meta

type Story = StoryObj<typeof PipelineExplorer>

/**
 * A ready runtime that returns a fixed parse.
 */
export const Ready: Story = { args: { runtime: makePipelineRuntime() } }

/**
 * A runtime that is still loading its bundle.
 */
export const Loading: Story = {
	args: {
		runtime: makePipelineRuntime({
			ready: false,
			loading: { progress: "Downloading model…", stepLabels: ["Model", "Tokenizer", "Gazetteer"], stepIndex: 1 },
		}),
	},
}

/**
 * A ready runtime with a host `extras` panel that shows the raw parse nodes.
 */
export const WithExtras: Story = {
	args: {
		runtime: makePipelineRuntime(),
		panels: {
			extras: (result) => (
				<details>
					<summary>Raw nodes ({result.nodes.length})</summary>
					<pre>{prettyJSON(result.nodes)}</pre>
				</details>
			),
		},
	},
}
