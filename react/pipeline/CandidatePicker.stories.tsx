/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { CandidatePicker } from "./CandidatePicker.tsx"

const meta: Meta<typeof CandidatePicker> = {
	title: "Pipeline/CandidatePicker",
	component: CandidatePicker,
	args: {
		selectedIndex: 0,
		onSelect: () => {},
		candidates: [
			{ id: 85977539, name: "New York", placetype: "locality", lat: 40.71, lon: -74.0, score: 0.82 },
			{ id: 101715829, name: "New York", placetype: "region", lat: 43.0, lon: -75.0, score: 0.55 },
			{ id: 1234, name: "New York Mills", placetype: "locality", lat: 43.1, lon: -75.3, score: 0.31 },
		],
	},
}

export default meta
type Story = StoryObj<typeof CandidatePicker>

export const Default: Story = {}
