// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { useEffect, useState } from "react"

import { loadSearchIndex, type PlanetarySearch } from "#search/index"

export type SearchIndexState =
	| { status: "loading"; index: null; error: null }
	| { status: "ready"; index: PlanetarySearch; error: null }
	| { status: "failed"; index: null; error: Error }

const LOADING: SearchIndexState = { status: "loading", index: null, error: null }

/**
 * The search artifact, loaded once per URL. A failure is a state the app renders rather than a silent empty search.
 */
export function useSearchIndex(url: string): SearchIndexState {
	const [state, setState] = useState<SearchIndexState>(LOADING)

	useEffect(() => {
		let cancelled = false

		loadSearchIndex(url).then(
			(index) => {
				if (!cancelled) {
					setState({ status: "ready", index, error: null })
				}
			},
			(error: unknown) => {
				if (!cancelled) {
					setState({ status: "failed", index: null, error: error as Error })
				}
			}
		)

		return () => {
			cancelled = true
		}
	}, [url])

	return state
}
