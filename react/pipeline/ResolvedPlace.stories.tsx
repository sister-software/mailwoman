/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { ResolvedPlace } from "./ResolvedPlace.tsx"

const meta: Meta<typeof ResolvedPlace> = {
	title: "Pipeline/ResolvedPlace",
	component: ResolvedPlace,
	args: {
		place: { id: 85977539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 },
	},
}

export default meta
type Story = StoryObj<typeof ResolvedPlace>

export const Default: Story = {}

export const DualRole: Story = {
	args: {
		dualRoles: [{ id: 1, name: "New York", placetype: "region", relationshipType: "city-state", role: "region" }],
	},
}
