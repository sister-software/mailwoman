// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The selected feature as a definition list: what the archive records about it,
 * in the archive's own terms, with the source identifier.
 *
 * Semantic HTML gives a screen reader the same record that a sighted reader sees.
 *
 * `FeaturePanel` renders inside `<MapSheet>`, so it uses the same glass,
 * control-column position, mobile treatment and close button.
 * Changes to the shared material update the panel's layout.
 *
 */

import { MapSheet } from "@mailwoman/react/map/chrome/MapSheet"

import { formatCoordinates, formatDiameter, type SelectedFeature } from "#features/selected"

export interface FeaturePanelProps {
	feature: SelectedFeature
	latitudeType: string
	onClose: () => void
}

export function FeaturePanel({ feature, latitudeType, onClose }: FeaturePanelProps) {
	const diameter = formatDiameter(feature.diameterKm)

	return (
		<MapSheet title={feature.name} onClose={onClose} className="feature-panel">
			<dl>
				<dt>Type</dt>
				<dd>
					{feature.featureType}
					{feature.featureTypeCode ? <span className="feature-panel__code"> {feature.featureTypeCode}</span> : null}
				</dd>
				<dt>Coordinates</dt>
				<dd>
					{formatCoordinates(feature.centerLon, feature.centerLat)}
					<span className="feature-panel__convention"> {latitudeType}, east-positive</span>
				</dd>
				{diameter ? (
					<>
						<dt>Diameter</dt>
						<dd>{diameter}</dd>
					</>
				) : null}
				{feature.origin ? (
					<>
						<dt>Origin</dt>
						<dd>{feature.origin}</dd>
					</>
				) : null}
				{feature.approvalStatus ? (
					<>
						<dt>Approval</dt>
						<dd>
							{feature.approvalStatus}
							{feature.approvalDate ? `, ${feature.approvalDate}` : null}
						</dd>
					</>
				) : null}
			</dl>
			<p className="feature-panel__source">Source: USGS Astrogeology / IAU Gazetteer of Planetary Nomenclature</p>
		</MapSheet>
	)
}
