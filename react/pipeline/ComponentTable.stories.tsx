/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { ComponentTable } from "./ComponentTable.tsx"

const meta: Meta<typeof ComponentTable> = {
	title: "Pipeline/ComponentTable",
	component: ComponentTable,
}

export default meta
type Story = StoryObj<typeof ComponentTable>

export const Default: Story = {
	args: {
		nodes: [
			{ tag: "house_number", value: "350", confidence: 0.97 },
			{ tag: "street", value: "5th Ave", confidence: 0.62 },
			{ tag: "locality", value: "New York", confidence: 0.41 },
			{ tag: "postcode", value: "10118" },
		],
	},
}
