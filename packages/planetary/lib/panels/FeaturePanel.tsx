/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The selected feature as a definition list: what the archive says about it, in the archive's own terms, with the
 *   source named. Semantic HTML so a screen reader gets the same record a sighted reader does.
 *
 *   It rides `<MapSheet>` rather than carrying its own panel. The glass, the position beside the control column, the
 *   phone treatment and the close button were all copied here once, and a copy of a material drifts from it the first
 *   time the material changes.
 */

import { MapSheet } from "@mailwoman/react/map/MapSheet"

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
