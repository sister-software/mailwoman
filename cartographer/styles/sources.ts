// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { SourceSpecification } from "maplibre-gl"
import type { Tagged } from "type-fest"

//#region Type Definitions

/**
 * The tilesets available in the tile API.
 */
export type TileSetSourceID<T extends string = string> = Tagged<string, "TileSetSourceID", T>

/**
 * Declares a tileset identifier.
 */
export function TileSetSourceID<T extends string>(value: T): TileSetSourceID<T> {
	return value as unknown as TileSetSourceID<T>
}

/**
 * Vector source specifications for each tileset.
 */
export type TileSetSourceRecord = Record<TileSetSourceID, SourceSpecification>
