/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Composed POIExplorer stories with a MOCK taxonomy runtime + mock live probe — no taxonomy load,
 *   no httpvfs, no network.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import {
	makeBrandPOIRuntime,
	makePOIRuntime,
	mockBrandLiveSearchSuccess,
	mockLiveSearchSuccess,
} from "../test/mocks.tsx"
import { POIExplorer } from "./POIExplorer.tsx"

const meta: Meta<typeof POIExplorer> = {
	title: "POI/POIExplorer",
	component: POIExplorer,
	args: {
		defaultText: "drinking fountain near Springfield",
		loadRuntime: async () => makePOIRuntime(),
	},
}

export default meta
type Story = StoryObj<typeof POIExplorer>

export const IntentOnly: Story = {}

export const WithLiveSearch: Story = { args: { runLiveSearch: mockLiveSearchSuccess } }

/**
 * A chain-brand subject, intent-only — the QID chip renders but no live block (the docs' default: no brand-capable
 * probe).
 */
export const BrandIntentOnly: Story = {
	args: { defaultText: "chevron near Houston", loadRuntime: async () => makeBrandPOIRuntime() },
}

/** A chain-brand subject with a brand-capable probe wired — the live block appears and searches by QID. */
export const BrandWithLiveSearch: Story = {
	args: {
		defaultText: "chevron near Houston",
		loadRuntime: async () => makeBrandPOIRuntime(),
		runLiveSearch: mockBrandLiveSearchSuccess,
		brandLiveSearch: true,
	},
}
