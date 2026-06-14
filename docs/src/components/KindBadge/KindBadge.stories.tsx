/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { KindBadge } from "./KindBadge.tsx"

const meta = {
	title: "Demo/KindBadge",
	component: KindBadge,
	tags: ["autodocs"],
} satisfies Meta<typeof KindBadge>

export default meta

type Story = StoryObj<typeof meta>

/** A confident structured-address verdict with a couple of weaker alternatives. */
export const StructuredAddress: Story = {
	args: {
		kindResult: {
			kind: "structured_address",
			confidence: 0.94,
			alternatives: [
				{ kind: "locality_only", confidence: 0.04 },
				{ kind: "venue_query", confidence: 0.02 },
			],
		},
	},
}

/** A bare ZIP code — the classifier's `postcode_only` bucket, here with no alternatives. */
export const PostcodeOnly: Story = {
	args: {
		kindResult: {
			kind: "postcode_only",
			confidence: 0.99,
			alternatives: [],
		},
	},
}

/** A genuinely ambiguous single-token input where the top two kinds are close. */
export const Ambiguous: Story = {
	args: {
		kindResult: {
			kind: "locality_only",
			confidence: 0.52,
			alternatives: [
				{ kind: "venue_query", confidence: 0.41 },
				{ kind: "structured_address", confidence: 0.07 },
			],
		},
	},
}
