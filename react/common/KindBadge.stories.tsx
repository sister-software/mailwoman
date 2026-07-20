/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { KindBadge } from "./KindBadge.tsx"

const meta: Meta<typeof KindBadge> = {
	title: "Common/KindBadge",
	component: KindBadge,
}

export default meta
type Story = StoryObj<typeof KindBadge>

export const WithAlternatives: Story = {
	args: {
		kindResult: {
			kind: "poi_query",
			confidence: 0.92,
			alternatives: [
				{ kind: "structured_address", confidence: 0.31 },
				{ kind: "locality_only", confidence: 0.12 },
			],
		},
	},
}

export const NoAlternatives: Story = {
	args: { kindResult: { kind: "postcode_only", confidence: 1, alternatives: [] } },
}
