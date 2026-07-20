/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { SubjectPanel } from "./SubjectPanel.tsx"
import type { CategoryRecord } from "./types.ts"

const meta: Meta<typeof SubjectPanel> = {
	title: "POI/SubjectPanel",
	component: SubjectPanel,
}

export default meta
type Story = StoryObj<typeof SubjectPanel>

const category = (label: string): CategoryRecord => ({ id: label.toLowerCase(), label }) as unknown as CategoryRecord

export const WithAnchor: Story = {
	args: {
		subject: {
			kind: "category",
			category: category("Hospital"),
			matchedPhrase: "hospital",
			confidence: 0.84,
			remainder: "New York",
			buildLocal: false,
		},
	},
}

export const BuildLocal: Story = {
	args: {
		subject: {
			kind: "category",
			category: category("Drinking Fountain"),
			matchedPhrase: "drinking fountain",
			confidence: 0.91,
			remainder: "Springfield",
			buildLocal: true,
		},
	},
}

export const Brand: Story = {
	args: {
		subject: {
			kind: "brand",
			name: "Chevron",
			wikidata: "Q319642",
			matchedPhrase: "chevron",
			confidence: 1,
			remainder: "Houston",
		},
	},
}

export const BrandNoQID: Story = {
	args: {
		subject: {
			kind: "brand",
			name: "Chevron",
			matchedPhrase: "chevron",
			confidence: 1,
			remainder: "Houston",
		},
	},
}
