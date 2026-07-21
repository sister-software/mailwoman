/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<PlaceAutocomplete>` — the suggestion listbox with fake suggestions (hover/click to highlight), and
 *   the empty case where it renders nothing. No maplibre; plain DOM.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { FAKE_SUGGESTIONS } from "../test/mocks.tsx"
import { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"

const meta: Meta<typeof PlaceAutocomplete> = { title: "Map/Panels/PlaceAutocomplete", component: PlaceAutocomplete }
export default meta
type Story = StoryObj<typeof PlaceAutocomplete>

/** Three fake suggestions; the first is highlighted, hover to move it. */
export const WithSuggestions: Story = {
	render: () => {
		const [active, setActive] = useState(0)

		return (
			<PlaceAutocomplete
				suggestions={FAKE_SUGGESTIONS}
				activeIndex={active}
				onPick={() => {}}
				onHover={setActive}
				listboxId="story-suggest"
				optionId={(i) => `story-suggest-${i}`}
			/>
		)
	},
}

/** No suggestions → the listbox renders nothing. */
export const Empty: Story = {
	render: () => (
		<>
			<p style={{ opacity: 0.6 }}>(no suggestions → listbox hidden)</p>
			<PlaceAutocomplete
				suggestions={[]}
				activeIndex={-1}
				onPick={() => {}}
				listboxId="story-suggest"
				optionId={(i) => `story-suggest-${i}`}
			/>
		</>
	),
}
