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
	args: { categoryLabel: "Drinking Fountain", anchor: "Springfield", onSearch: () => {} },
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

export const NoAnchor: Story = { args: { anchor: "", state: { status: "idle" } } }

export const Error: Story = { args: { state: { status: "error", message: "the published POI layer isn't reachable" } } }
