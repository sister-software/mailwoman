/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The selected feature as a definition list: what the archive says about it, in the archive's own terms, with the
 *   source named. Semantic HTML so a screen reader gets the same record a sighted reader does.
 */

import { formatCoordinates, formatDiameter, type SelectedFeature } from "#features/selected"

export interface FeaturePanelProps {
	feature: SelectedFeature
	latitudeType: string
	onClose: () => void
}

const PANEL_TITLE_ID = "feature-panel-title"

export function FeaturePanel({ feature, latitudeType, onClose }: FeaturePanelProps) {
	const diameter = formatDiameter(feature.diameterKm)

	return (
		<article className="feature-panel" aria-labelledby={PANEL_TITLE_ID}>
			<header className="feature-panel__header">
				<h2 id={PANEL_TITLE_ID}>{feature.name}</h2>
				<button type="button" className="feature-panel__close" onClick={onClose} aria-label="Close">
					×
				</button>
			</header>
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
		</article>
	)
}
