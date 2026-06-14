/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import type { ResultNode } from "../../shared/resources.tsx"
import { SpanHighlight } from "./SpanHighlight.tsx"

const WHITE_HOUSE = "1600 Pennsylvania Ave NW, Washington, DC 20500"

const whiteHouseNodes: ResultNode[] = [
	{ tag: "house_number", value: "1600", confidence: 0.98, start: 0, end: 4 },
	{ tag: "street", value: "Pennsylvania Ave NW", confidence: 0.91, start: 5, end: 24 },
	{ tag: "locality", value: "Washington", confidence: 0.86, start: 26, end: 36 },
	{ tag: "region", value: "DC", confidence: 0.71, start: 38, end: 40 },
	{ tag: "postcode", value: "20500", confidence: 0.95, start: 41, end: 46 },
]

const meta = {
	title: "Demo/SpanHighlight",
	component: SpanHighlight,
	tags: ["autodocs"],
} satisfies Meta<typeof SpanHighlight>

export default meta

type Story = StoryObj<typeof meta>

/** A fully-parsed US address with confidence-tinted spans across every component. */
export const WhiteHouse: Story = {
	args: { input: WHITE_HOUSE, nodes: whiteHouseNodes },
}

/** A low-confidence parse — most spans land in the amber/red tiers. */
export const LowConfidence: Story = {
	args: {
		input: "pier 39 sf",
		nodes: [
			{ tag: "venue", value: "pier 39", confidence: 0.44, start: 0, end: 7 },
			{ tag: "locality", value: "sf", confidence: 0.38, start: 8, end: 10 },
		],
	},
}

/** No spans carry offsets, so nothing is highlighted — the empty/degenerate case. */
export const NoSpans: Story = {
	args: { input: "90210", nodes: [{ tag: "postcode", value: "90210", confidence: 0.99 }] },
}
