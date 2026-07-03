/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import type { ParseTraceLike } from "../../shared/resources.tsx"
import fixture from "./fixtures/white-house.trace.json"
import { ModelVisualizer } from "./ModelVisualizer.tsx"

const meta = {
	title: "Demo/ModelVisualizer",
	component: ModelVisualizer,
	tags: ["autodocs"],
} satisfies Meta<typeof ModelVisualizer>

export default meta

type Story = StoryObj<typeof meta>

export const WhiteHouse: Story = {
	args: { trace: fixture as unknown as ParseTraceLike },
}

export const EmptyInput: Story = {
	args: {
		trace: {
			text: "",
			caseNormalized: false,
			pieces: [],
			logits: [],
			detectedSystem: null,
			systemSource: "off",
			priors: [],
			emissions: [],
			labels: [],
			path: [],
			decode: "viterbi",
			repairs: [],
			tokens: [],
		},
	},
}
