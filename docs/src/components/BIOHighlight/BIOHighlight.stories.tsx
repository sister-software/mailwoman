/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import type { ResultNode } from "../../shared/resources.tsx"
import { BIOHighlight } from "./BIOHighlight.tsx"

const WHITE_HOUSE = "1600 Pennsylvania Ave NW, Washington, DC 20500"

const whiteHouseNodes: ResultNode[] = [
	{ tag: "house_number", value: "1600", confidence: 0.98, start: 0, end: 4 },
	{ tag: "street", value: "Pennsylvania Ave NW", confidence: 0.91, start: 5, end: 24 },
	{ tag: "locality", value: "Washington", confidence: 0.86, start: 26, end: 36 },
	{ tag: "region", value: "DC", confidence: 0.71, start: 38, end: 40 },
	{ tag: "postcode", value: "20500", confidence: 0.95, start: 41, end: 46 },
]

const meta = {
	title: "Demo/BIOHighlight",
	component: BIOHighlight,
	tags: ["autodocs"],
} satisfies Meta<typeof BIOHighlight>

export default meta

type Story = StoryObj<typeof meta>

/** Word-level B-/I- labels derived from the span offsets of a full parse. */
export const WhiteHouse: Story = {
	args: { input: WHITE_HOUSE, nodes: whiteHouseNodes },
}

/** A multi-word locality shows the B-/I- continuation across tokens. */
export const MultiWordLocality: Story = {
	args: {
		input: "350 5th Ave, New York, NY 10118",
		nodes: [
			{ tag: "house_number", value: "350", confidence: 0.97, start: 0, end: 3 },
			{ tag: "street", value: "5th Ave", confidence: 0.9, start: 4, end: 11 },
			{ tag: "locality", value: "New York", confidence: 0.88, start: 13, end: 21 },
			{ tag: "region", value: "NY", confidence: 0.8, start: 23, end: 25 },
			{ tag: "postcode", value: "10118", confidence: 0.96, start: 26, end: 31 },
		],
	},
}
