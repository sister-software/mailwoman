/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { OverpassBlock } from "./OverpassBlock.tsx"

const meta: Meta<typeof OverpassBlock> = {
	title: "POI/OverpassBlock",
	component: OverpassBlock,
}

export default meta
type Story = StoryObj<typeof OverpassBlock>

export const Query: Story = {
	args: {
		overpassQL: "[out:json][timeout:25];\nnode[amenity=drinking_water](area.searchArea);\nout center;",
	},
}

export const EmitterError: Story = { args: { overpassError: "no osmTag mapping for category" } }
