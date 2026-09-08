/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The map chrome over a stand-in map. Every story sits on a coloured ground rather than white, because glass is a
 *   material over something — reviewed on a blank page it says nothing about whether it is readable in place.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { MapChipRow } from "./MapChipRow.tsx"
import { MapCompass } from "./MapCompass.tsx"
import { MapControlButton, MapControlGroup, MapControlStack } from "./MapControlStack.tsx"
import { MapFooter } from "./MapFooter.tsx"
import { MapSearchBar } from "./MapSearchBar.tsx"

const EXAMPLES = [
	{ label: "White House" },
	{ label: "Apple Park" },
	{ label: "30 Rockefeller Plaza" },
	{ label: "Pier 39 SF" },
	{ label: "Wrigley Field" },
	{ label: "Space Needle" },
	{ label: "Berlin (native order)" },
	{ label: "Paris (street fall-through)" },
]

/**
 * A stand-in for a map: a ground with enough tonal range that a translucent panel has something to be translucent over.
 */
function MapGround({ children }: { children: React.ReactNode }) {
	return (
		<div
			style={{
				position: "relative",
				height: 460,
				borderRadius: 12,
				overflow: "hidden",
				background: "linear-gradient(135deg, #24384f 0%, #47637f 45%, #8fa3b4 100%)",
			}}
		>
			{children}
		</div>
	)
}

const meta = {
	title: "Map/Chrome",
	parameters: { layout: "padded" },
} satisfies Meta

export default meta

export const FullChrome: StoryObj = {
	render: () => {
		const [query, setQuery] = useState("1600 Pennsylvania Ave NW, Washington, DC")
		const [bearing, setBearing] = useState(38)
		const [layersOpen, setLayersOpen] = useState(false)

		return (
			<MapGround>
				<div
					style={{
						position: "absolute",
						inset: 0,
						padding: "1rem",
						display: "grid",
						gap: "0.6rem",
						alignContent: "start",
					}}
				>
					<MapSearchBar
						label="Search addresses"
						leading={<span aria-hidden="true">⌕</span>}
						trailing={
							query ? (
								<button
									type="button"
									aria-label="Clear"
									onClick={() => setQuery("")}
									style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer" }}
								>
									×
								</button>
							) : null
						}
					>
						<input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Address" />
					</MapSearchBar>

					<MapChipRow chips={EXAMPLES} label="Example addresses" onPick={setQuery} />
				</div>

				<MapControlStack label="Map controls">
					<MapControlGroup>
						<MapControlButton label="Layers" active={layersOpen} onPress={() => setLayersOpen((open) => !open)}>
							<span aria-hidden="true">☰</span>
						</MapControlButton>
						<MapControlButton label="Locate me" onPress={() => undefined}>
							<span aria-hidden="true">◎</span>
						</MapControlButton>
					</MapControlGroup>

					<MapCompass bearing={bearing} onResetNorth={() => setBearing(0)} />
				</MapControlStack>

				<div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
					<MapFooter
						identity={<strong>Mailwoman Earth</strong>}
						attribution={["© OpenStreetMap", "Protomaps", "MapLibre"]}
					/>
				</div>

				<button
					type="button"
					onClick={() => setBearing((current) => (current === 0 ? 38 : 0))}
					style={{ position: "absolute", left: "1rem", bottom: "3rem" }}
				>
					Toggle bearing (now {bearing}°)
				</button>
			</MapGround>
		)
	},
}

/**
 * The compass on its own, so the fade in and out is reviewable without the rest of the chrome moving.
 */
export const Compass: StoryObj = {
	render: () => {
		const [bearing, setBearing] = useState(0)

		return (
			<MapGround>
				<MapControlStack label="Map controls">
					<MapCompass bearing={bearing} onResetNorth={() => setBearing(0)} />
				</MapControlStack>

				<div style={{ position: "absolute", left: "1rem", bottom: "1rem", display: "flex", gap: "0.5rem" }}>
					{[0, 15, 90, 180].map((degrees) => (
						<button key={degrees} type="button" onClick={() => setBearing(degrees)}>
							{degrees}°
						</button>
					))}
				</div>
			</MapGround>
		)
	},
}

/**
 * Many chips, to show the row scrolls on one line rather than wrapping into a block that eats the map.
 */
export const ChipsOverflow: StoryObj = {
	render: () => (
		<MapGround>
			<div style={{ position: "absolute", inset: 0, padding: "1rem" }}>
				<MapChipRow
					chips={[
						...EXAMPLES,
						{ label: "Macclesfield (GB dependent_locality)" },
						{ label: "Plimmerton (NZ dependent_locality)" },
					]}
					activeValue="Apple Park"
					label="Example addresses"
					onPick={() => undefined}
				/>
			</div>
		</MapGround>
	),
}
