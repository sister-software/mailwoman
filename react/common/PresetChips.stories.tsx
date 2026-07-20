/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { PresetChips } from "./PresetChips.tsx"

const meta: Meta<typeof PresetChips> = {
	title: "Common/PresetChips",
	component: PresetChips,
	args: { onPick: () => {} },
}

export default meta
type Story = StoryObj<typeof PresetChips>

export const Default: Story = {
	args: {
		presets: [
			{ label: "White House", value: "1600 Pennsylvania Ave NW" },
			{ label: "Apple Park", value: "1 Apple Park Way" },
			{ label: "ZIP only", value: "90210" },
		],
	},
}
