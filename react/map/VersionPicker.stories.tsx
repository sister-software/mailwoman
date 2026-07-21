/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<VersionPicker>` states over fake data — a stateful three-option picker, a disabled one, and the
 *   single-version case where the control renders nothing. No maplibre; plain DOM.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import type { DemoVersionOption } from "./types.ts"
import { VersionPicker } from "./VersionPicker.tsx"

const VERSIONS: DemoVersionOption[] = [
	{ version: "v7.2.0", label: "v7.2.0 (latest)" },
	{ version: "v7.1.0", label: "v7.1.0" },
	{ version: "v6.4.0", label: "v6.4.0" },
]

const meta: Meta<typeof VersionPicker> = { title: "Map/Panels/VersionPicker", component: VersionPicker }
export default meta
type Story = StoryObj<typeof VersionPicker>

/** Three options, driven by local state. */
export const ThreeOptions: Story = {
	render: () => {
		const [selected, setSelected] = useState("v7.2.0")

		return <VersionPicker versions={VERSIONS} selected={selected} onSelect={setSelected} />
	},
}

/** Disabled (e.g. while a parse runs). */
export const Disabled: Story = {
	args: { versions: VERSIONS, selected: "v7.1.0", onSelect: () => {}, disabled: true },
}

/** A single version → the picker renders nothing. */
export const SingleHidden: Story = {
	render: () => (
		<>
			<p style={{ opacity: 0.6 }}>(one version → picker hidden)</p>
			<VersionPicker versions={[VERSIONS[0]!]} selected="v7.2.0" onSelect={() => {}} />
		</>
	),
}
