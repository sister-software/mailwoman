/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { makeBrandPOIRuntime, makePOIRuntime, mockBrandLiveSearchSuccess, mockLiveSearchSuccess } from "#test/mocks"

import { POIExplorer } from "./POIExplorer.tsx"

/**
 * Stories for `POIExplorer` with a mock taxonomy runtime and mock live-search probes,
 * so they make no network requests.
 */
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

/**
 * A category query without a live-search probe.
 */
export const IntentOnly: Story = {}

/**
 * A category query with a live-search probe.
 */
export const WithLiveSearch: Story = { args: { runLiveSearch: mockLiveSearchSuccess } }

/**
 * A brand query without a brand-capable probe.
 * The QID chip renders, and the live block does not.
 */
export const BrandIntentOnly: Story = {
	args: { defaultText: "chevron near Houston", loadRuntime: async () => makeBrandPOIRuntime() },
}

/**
 * A brand query with a brand-capable probe.
 * The live block appears and searches by QID.
 */
export const BrandWithLiveSearch: Story = {
	args: {
		defaultText: "chevron near Houston",
		loadRuntime: async () => makeBrandPOIRuntime(),
		runLiveSearch: mockBrandLiveSearchSuccess,
		brandLiveSearch: true,
	},
}
