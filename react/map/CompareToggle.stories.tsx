/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<CompareToggle>` states — off (just the checkbox), and on (the compare-version select with the
 *   primary filtered out + a status line). No maplibre; plain DOM.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { CompareToggle } from "./CompareToggle.tsx"
import type { DemoVersionOption } from "./types.ts"

const VERSIONS: DemoVersionOption[] = [
	{ version: "v7.2.0", label: "v7.2.0 (latest)" },
	{ version: "v7.1.0", label: "v7.1.0" },
	{ version: "v6.4.0", label: "v6.4.0" },
]

const meta: Meta<typeof CompareToggle> = { title: "Map/Panels/CompareToggle", component: CompareToggle }
export default meta
type Story = StoryObj<typeof CompareToggle>

/** Interactive: flip the toggle to reveal the compare-version select (the primary version is filtered out). */
export const OffThenOn: Story = {
	render: () => {
		const [mode, setMode] = useState(false)
		const [version, setVersion] = useState<string | null>(null)

		return (
			<CompareToggle
				versions={VERSIONS}
				primaryVersion="v7.2.0"
				compareMode={mode}
				onCompareModeChange={setMode}
				compareVersion={version}
				onCompareVersionChange={setVersion}
			/>
		)
	},
}

/** On, with a chosen compare version + a status line. */
export const OnWithStatus: Story = {
	render: () => (
		<CompareToggle
			versions={VERSIONS}
			primaryVersion="v7.2.0"
			compareMode
			onCompareModeChange={() => {}}
			compareVersion="v6.4.0"
			onCompareVersionChange={() => {}}
			status={<span>Backend: webgpu (26 MB int8)</span>}
		/>
	),
}
