// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The rows of the map's right-click menu: the clicked point in each encoding {@link describePoint} offers.
 *   The encodings arrive after the H3 encoder loads, so the rows render once they are read.
 */

import type { MapContextMenuPoint, MapContextMenuRowProps } from "@mailwoman/react/map"
import { MapContextMenuRow } from "@mailwoman/react/map/MapContextMenu"
import type React from "react"
import { useEffect, useState } from "react"

import { describePoint } from "#runtime/point/formats"

export const PointFormats: React.FC<{ point: MapContextMenuPoint }> = ({ point }) => {
	const [formats, setFormats] = useState<MapContextMenuRowProps[] | null>(null)
	const [lon, lat] = point.lngLat

	useEffect(() => {
		let current = true

		void describePoint(lat, lon, point.zoom).then((read) => {
			if (current) {
				setFormats(read)
			}
		})

		return () => {
			current = false
		}
	}, [lat, lon, point.zoom])

	return (
		<>
			{(formats ?? []).map((format) => (
				<MapContextMenuRow key={format.label} {...format} />
			))}
		</>
	)
}
