// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The IHO-IOC GEBCO Gazetteer of Undersea Feature Names as a sealed layer,
 *   and the name index Earth searches its browser asset with.
 */

export {
	type UnderseaAsset,
	type UnderseaAssetFeature,
	type UnderseaBBox,
	type UnderseaDepthKind,
	type UnderseaFeatureProperties,
	UnderseaIndex,
	underseaNameKey,
} from "#features"

export {
	UNDERSEA_ATTRIBUTION,
	UNDERSEA_LAYER_NAME,
	UNDERSEA_LICENSE,
	UNDERSEA_USE_LIMIT,
	UnderseaGeometryKind,
	underseaDisplayName,
} from "#vocabulary"
