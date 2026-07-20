/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Composed POIExplorer stories with a MOCK taxonomy runtime + mock live probe — no taxonomy load,
 *   no httpvfs, no network.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { makePOIRuntime, mockLiveSearchSuccess } from "../test/mocks.tsx"
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
