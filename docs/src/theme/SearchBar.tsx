/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The navbar search control. It opens the search modal on a click, on Ctrl+K or Cmd+K, and on `/`
 *   pressed outside a text field. The index is opened in the sqlite-wasm worker on the first query and
 *   kept for the page's lifetime.
 */

import "@mailwoman/react/styles.css"
import { useHistory } from "@docusaurus/router"
import { SearchModal } from "@mailwoman/react/search/SearchModal"
import type { SearchResponse } from "@mailwoman/react/search/types"
import { openWholeDatabase, type RangeDatabase } from "@mailwoman/resolver-wof-wasm/httpvfs/database"
import { useCallback, useEffect, useRef, useState } from "react"

import { SEARCH_INDEX_PATH, SQLITE_RUNTIME_PATH } from "../search/constants.ts"
import { search } from "../search/search.ts"

function isEditable(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export default function SearchBar() {
	const history = useHistory()
	const [open, setOpen] = useState(false)
	const database = useRef<Promise<RangeDatabase> | undefined>(undefined)

	const runSearch = useCallback(async (q: string, signal: AbortSignal): Promise<SearchResponse> => {
		// A failed open clears the memo so the next query retries.
		database.current ??= openWholeDatabase(SEARCH_INDEX_PATH, SQLITE_RUNTIME_PATH).catch((error: unknown) => {
			database.current = undefined
			throw error
		})

		const db = await database.current

		if (signal.aborted) throw new DOMException("aborted", "AbortError")

		return search(db, q)
	}, [])

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const shortcut =
				(event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !isEditable(event.target))

			if (!shortcut) return

			event.preventDefault()
			setOpen(true)
		}

		globalThis.addEventListener("keydown", onKeyDown)

		return () => globalThis.removeEventListener("keydown", onKeyDown)
	}, [])

	return (
		<>
			<button
				type="button"
				className="navbar__search-button"
				aria-keyshortcuts="Control+K Meta+K /"
				onClick={() => setOpen(true)}
			>
				Search
			</button>
			<SearchModal
				open={open}
				onClose={() => setOpen(false)}
				onNavigate={(href) => history.push(href)}
				search={runSearch}
			/>
		</>
	)
}
