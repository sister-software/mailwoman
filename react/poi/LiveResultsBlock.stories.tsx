/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { LiveResultsBlock } from "./LiveResultsBlock.tsx"

const meta: Meta<typeof LiveResultsBlock> = {
	title: "POI/LiveResultsBlock",
	component: LiveResultsBlock,
	args: { subjectLabel: "Drinking Fountain", anchor: "Springfield", onSearch: () => {} },
}

export default meta
type Story = StoryObj<typeof LiveResultsBlock>

export const Success: Story = {
	args: {
		state: {
			status: "success",
			centerName: "Springfield, IL",
			hits: [
				{ name: "Washington Park Fountain", lat: 39.79, lon: -89.65, distanceM: 320, country: "US", confidence: 0.8 },
				{ name: "Lincoln Library Fountain", lat: 39.8, lon: -89.64, distanceM: 910, country: "US", confidence: 0.7 },
			],
		},
	},
}

export const Brand: Story = {
	args: {
		subjectLabel: "Chevron",
		anchor: "Houston",
		state: {
			status: "success",
			centerName: "Houston, TX",
			hits: [
				{ name: "Chevron", lat: 29.76, lon: -95.37, distanceM: 210, country: "US", confidence: 0.9 },
				{ name: "Chevron", lat: 29.79, lon: -95.4, distanceM: 4200, country: "US", confidence: 0.85 },
			],
		},
	},
}

export const NoAnchor: Story = { args: { anchor: "", state: { status: "idle" } } }

export const Error: Story = { args: { state: { status: "error", message: "the published POI layer isn't reachable" } } }
