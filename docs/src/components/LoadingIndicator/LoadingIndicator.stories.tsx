/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { LoadingIndicator } from "./LoadingIndicator.tsx"

const meta = {
	title: "Demo/LoadingIndicator",
	component: LoadingIndicator,
	tags: ["autodocs"],
	argTypes: {
		mode: { control: "inline-radio", options: ["spinner", "pulse", "staged"] },
		size: { control: "inline-radio", options: ["small", "medium", "large"] },
	},
} satisfies Meta<typeof LoadingIndicator>

export default meta

type Story = StoryObj<typeof meta>

export const Spinner: Story = {
	args: { mode: "spinner", size: "medium", label: "Loading model…" },
}

export const Pulse: Story = {
	args: { mode: "pulse", barCount: 3, label: "Parsing…" },
}

/** Staged mode drives the demo's "Analyzing → Classifying → Resolving" pipeline progress list. */
export const Staged: Story = {
	args: {
		mode: "staged",
		activeStep: 1,
		steps: ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"],
	},
}
