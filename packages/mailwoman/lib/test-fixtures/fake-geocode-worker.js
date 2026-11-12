// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A fake geocode worker (no real model/DB) that proves geocodeStream's wiring:
 * workerData config and the record both arrive, and results flow back.
 *
 * It tags each record's address with the config locale and the mapped-address column count.
 */

import { workerData } from "node:worker_threads"

const { mapping, geocode } = workerData.userData

/** @param {{ raw: Record<string, string> }} record */
export function handleItem(record) {
	const cols = Array.isArray(mapping.address) ? mapping.address.length : mapping.address ? 1 : 0

	return { ...record, address: { tag: geocode.locale, cols } }
}
