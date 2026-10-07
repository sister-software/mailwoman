/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The docs search modal. A native `<dialog>` opened with `showModal()` supplies the focus trap, the inert
 *   background, the backdrop, the close on Escape and the return of focus to the opener. The query field is an
 *   `<input type="search">` with the ARIA combobox role. DOM focus stays on the input, and
 *   `aria-activedescendant` identifies the selected hit. The component owns no data access: `search` is
 *   passed in.
 */

import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"

import { useDebouncedValue } from "#common/useDebouncedValue"

import type { SearchHit, SearchResponse } from "./types.ts"

export interface SearchModalProps {
	open: boolean
	onClose: () => void
	/**
	 * Called with the hit's site-relative link on Enter or on an unmodified click.
	 * Absent, the link navigates as an ordinary anchor.
	 */
	onNavigate?: (href: string) => void
	/**
	 * Runs the query.
	 *
	 * The function must keep a stable identity across renders (for example through `useCallback`),
	 * because a new identity refires the request for the current query.
	 */
	search: (q: string, signal: AbortSignal) => Promise<SearchResponse>
}

type Status =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "results"; response: SearchResponse }
	| { kind: "failed" }

const DEBOUNCE_MS = 150

/**
 * How long a request runs before the live region announces that the index is loading.
 */
const LOADING_ANNOUNCE_MS = 300
const MAX_QUERY_LENGTH = 200
const DEFAULT_CATEGORY = "Documentation"

/**
 * The site-relative link for a hit.
 */
export function hitHref(hit: Pick<SearchHit, "url" | "anchor">): string {
	return hit.anchor === "" ? hit.url : `${hit.url}#${hit.anchor}`
}

function statusText(status: Status): string {
	if (status.kind === "failed") return "Search is unavailable. Try again in a moment."

	if (status.kind === "loading") return "Loading the search index…"

	if (status.kind === "idle") return ""

	const { response } = status

	if (!response.hits.length) return `No results for “${response.query}”.`

	return response.hits.length === 1 ? "1 result." : `${response.hits.length} results.`
}

function highlighted(hit: SearchHit): ReactNode[] {
	const parts: ReactNode[] = []
	let cursor = 0

	for (const [start, end] of hit.highlights) {
		if (start < cursor) continue

		parts.push(hit.snippet.slice(cursor, start), <mark key={start}>{hit.snippet.slice(start, end)}</mark>)
		cursor = end
	}

	parts.push(hit.snippet.slice(cursor))

	return parts
}

function title(hit: SearchHit): string {
	return hit.hierarchy
		.slice(1)
		.filter((entry): entry is string => entry !== null)
		.join(" › ")
}

export function SearchModal({ open, onClose, onNavigate, search }: SearchModalProps) {
	const dialogRef = useRef<HTMLDialogElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const baseID = useId()
	const listboxID = `${baseID}-listbox`
	const [query, setQuery] = useState("")
	const [settled, setSettled] = useState<Status>({ kind: "idle" })
	const [selected, setSelected] = useState(0)
	const [loading, setLoading] = useState(false)
	const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH)
	const debounced = useDebouncedValue(trimmed, DEBOUNCE_MS)

	useEffect(() => {
		const dialog = dialogRef.current

		if (!dialog) return

		if (open && !dialog.open) {
			dialog.showModal()
			inputRef.current?.focus()
		} else if (!open && dialog.open) {
			dialog.close()
		}
	}, [open])

	useEffect(() => {
		if (debounced === "") return

		// The abort of the earlier request keeps a late response from replacing newer results.
		const controller = new AbortController()
		const loadingTimer = setTimeout(() => setLoading(true), LOADING_ANNOUNCE_MS)

		search(debounced, controller.signal).then(
			(response) => {
				if (controller.signal.aborted) return

				clearTimeout(loadingTimer)
				setLoading(false)
				setSettled({ kind: "results", response })
				setSelected(0)
			},
			() => {
				if (controller.signal.aborted) return

				clearTimeout(loadingTimer)
				setLoading(false)
				setSettled({ kind: "failed" })
			}
		)

		return () => {
			clearTimeout(loadingTimer)
			setLoading(false)
			controller.abort()
		}
	}, [debounced, search])

	// An empty query shows no results, whatever the last settled response was.
	const status: Status = debounced === "" ? { kind: "idle" } : settled
	const response = status.kind === "results" ? status.response : undefined
	// The announcement reports a slow request while the last results stay on screen.
	const announced: Status = loading && debounced !== "" ? { kind: "loading" } : status

	const groups = useMemo(() => {
		const hits = response?.hits ?? []
		const byCategory = new Map<string, SearchHit[]>()

		for (const hit of hits) {
			const category = hit.hierarchy[0] ?? DEFAULT_CATEGORY

			byCategory.set(category, [...(byCategory.get(category) ?? []), hit])
		}

		// Options are numbered in display order so the arrow keys follow what the reader sees.
		let order = 0

		return [...byCategory].map(([category, entries]) => ({
			category,
			entries: entries.map((hit) => ({ hit, order: order++ })),
		}))
	}, [response])

	const ordered = groups.flatMap((group) => group.entries)
	const optionID = (order: number) => `${baseID}-option-${order}`

	function go(hit: SearchHit) {
		const href = hitHref(hit)

		onClose()

		if (onNavigate) {
			onNavigate(href)
		} else {
			globalThis.location.assign(href)
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		// A key that commits or edits an IME composition is not a command.
		if (event.nativeEvent.isComposing) return

		if (!ordered.length) return

		const last = ordered.length - 1

		const next =
			event.key === "ArrowDown"
				? selected === last
					? 0
					: selected + 1
				: event.key === "ArrowUp"
					? selected === 0
						? last
						: selected - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: undefined

		if (next !== undefined) {
			event.preventDefault()
			setSelected(next)
			document.getElementById(optionID(next))?.scrollIntoView({ block: "nearest" })
		} else if (event.key === "Enter") {
			event.preventDefault()

			// The hits on screen answer an earlier query until the debounce settles.
			if (trimmed !== debounced) return

			const entry = ordered[selected]

			if (entry) {
				go(entry.hit)
			}
		}
	}

	function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
		// A click whose target is the dialog element itself landed on the backdrop.
		if (event.target === event.currentTarget) {
			event.currentTarget.close()
		}
	}

	function onLinkClick(event: MouseEvent<HTMLAnchorElement>, hit: SearchHit) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return

		event.preventDefault()
		go(hit)
	}

	return (
		<dialog
			ref={dialogRef}
			className="mw-search"
			aria-label="Search the documentation"
			onClose={onClose}
			onClick={onDialogClick}
		>
			<form role="search" className="mw-search__form" onSubmit={(event) => event.preventDefault()}>
				<input
					ref={inputRef}
					type="search"
					className="mw-search__input"
					role="combobox"
					aria-label="Search the documentation"
					aria-autocomplete="list"
					aria-expanded={ordered.length > 0}
					aria-controls={listboxID}
					aria-activedescendant={ordered.length ? optionID(selected) : undefined}
					autoComplete="off"
					spellCheck={false}
					maxLength={MAX_QUERY_LENGTH}
					placeholder="Search the documentation"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={onKeyDown}
				/>
			</form>

			{response?.corrected !== undefined && (
				<p className="mw-search__corrected">Showing results for “{response.corrected}”</p>
			)}

			<div id={listboxID} role="listbox" aria-label="Search results" className="mw-search__results">
				{groups.map((group, groupIndex) => (
					<div
						key={group.category}
						role="group"
						aria-labelledby={`${baseID}-group-${groupIndex}`}
						className="mw-search__group"
					>
						<div id={`${baseID}-group-${groupIndex}`} className="mw-search__category">
							{group.category}
						</div>
						{group.entries.map(({ hit, order }) => (
							// The option is the link itself: an option may not contain an interactive element, and
							// `option` is an allowed role on `a[href]`, which keeps the URL for open-in-new-tab.
							<a
								key={order}
								id={optionID(order)}
								role="option"
								aria-selected={order === selected}
								href={hitHref(hit)}
								tabIndex={-1}
								className="mw-search__option"
								onPointerMove={() => setSelected(order)}
								onClick={(event) => onLinkClick(event, hit)}
							>
								<span className="mw-search__title">{title(hit)}</span>
								{hit.snippet !== "" && <span className="mw-search__snippet">{highlighted(hit)}</span>}
							</a>
						))}
					</div>
				))}
			</div>

			<p aria-live="polite" className="mw-search__status">
				{statusText(announced)}
			</p>
		</dialog>
	)
}
