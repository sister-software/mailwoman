/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The gazette explorer: a name search over the published browser gazetteer, and a place page with the
 *   place's facts, its ancestors, the other places filed under the same key, and the record as the resolver
 *   reads it. Every link inside the page is a `pushState`, so the opened gazetteer and its range cache
 *   survive the visit. A permalink reopens them.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"

import type { EarthConfig } from "#config"
import { type GazettePlaceRef, gazettePlaceFromPath, gazettePlacePath, searchWithQuery } from "#routes"

import {
	type Ancestor,
	ancestorsOf,
	type Gazetteer,
	nameKeyOf,
	openGazetteer,
	placeByRef,
	placesNamed,
	searchByPrefix,
	NAMED_ROW_LIMIT,
	searchContaining,
} from "./gazetteer.ts"
import { type NameGroup, type PlaceRow, resolverReading, spelunkerURL } from "./helpers.ts"

import styles from "./styles.module.css"

/**
 * How long the field rests before a keystroke's search runs.
 */
const DEBOUNCE_MS = 150

type SearchMode = "prefix" | "contains"

export interface GazettePageProps {
	config: EarthConfig
	/**
	 * The `?q=` the page opened with.
	 */
	query: string | null
	/**
	 * The place the path names, or null for the search page.
	 */
	place: GazettePlaceRef | null
}

interface PlaceView {
	row: PlaceRow
	ancestors: Ancestor[]
	siblings: PlaceRow[]
}

/**
 * A result the page keeps beside the place it answers, so a stale result is never shown for the next place.
 */
interface ForPlace<T> {
	ref: GazettePlaceRef
	value: T
}

const sameRef = (a: GazettePlaceRef, b: GazettePlaceRef): boolean => a.sprID === b.sprID && a.nameKey === b.nameKey

const forRef = <T,>(kept: ForPlace<T> | null, ref: GazettePlaceRef | null): T | null =>
	kept && ref && sameRef(kept.ref, ref) ? kept.value : null

const formatCount = (value: number | null): string => (value === null ? "unknown" : value.toLocaleString("en-US"))

export function GazettePage({ config, query, place }: GazettePageProps): React.JSX.Element {
	const [gazetteer, setGazetteer] = useState<Gazetteer | null>(null)
	const [openError, setOpenError] = useState<string | null>(null)
	const [text, setText] = useState(query ?? "")
	const [mode, setMode] = useState<SearchMode>("prefix")
	const [groups, setGroups] = useState<NameGroup[]>([])
	const [searching, setSearching] = useState(false)
	const [ref, setRef] = useState<GazettePlaceRef | null>(place)
	const [keptView, setKeptView] = useState<ForPlace<PlaceView> | null>(null)
	const [keptPlaceError, setKeptPlaceError] = useState<ForPlace<string> | null>(null)
	const [searchError, setSearchError] = useState<string | null>(null)
	const [bytesRead, setBytesRead] = useState<number | null>(null)

	const view = forRef(keptView, ref)
	const placeError = forRef(keptPlaceError, ref)

	// Only the newest search or place load may publish its result.
	const searchSequence = useRef(0)
	const placeSequence = useRef(0)

	useEffect(() => {
		let disposed = false

		openGazetteer(config.sqliteRuntimeBaseURL).then(
			(opened) => {
				if (!disposed) {
					setGazetteer(opened)
				}
			},
			(error: unknown) => {
				if (!disposed) {
					setOpenError(error instanceof Error ? error.message : String(error))
				}
			}
		)

		return () => {
			disposed = true
		}
	}, [config.sqliteRuntimeBaseURL])

	// The back and forward buttons walk the places this page pushed.
	useEffect(() => {
		const onPopState = () => {
			setRef(gazettePlaceFromPath(location.pathname))
		}

		addEventListener("popstate", onPopState)

		return () => removeEventListener("popstate", onPopState)
	}, [])

	const navigate = useCallback((next: GazettePlaceRef) => {
		history.pushState(null, "", `${gazettePlacePath(next)}${location.search}`)
		setRef(next)
	}, [])

	const runSearch = useCallback(
		(kind: SearchMode, input: string) => {
			if (!gazetteer) return

			const mine = ++searchSequence.current

			if (!nameKeyOf(input)) {
				setGroups([])
				setSearching(false)

				return
			}

			setSearching(true)

			const search = kind === "prefix" ? searchByPrefix : searchContaining

			search(gazetteer, input).then(
				async (found) => {
					if (mine !== searchSequence.current) return

					setGroups(found)
					setSearching(false)
					setSearchError(null)
					setBytesRead(await gazetteer.database.bytesRead())
					history.replaceState(history.state, "", searchWithQuery(new URL(location.href), input))
				},
				(error: unknown) => {
					if (mine !== searchSequence.current) return

					setSearching(false)
					setSearchError(error instanceof Error ? error.message : String(error))
				}
			)
		},
		[gazetteer]
	)

	// A prefix search follows the text after the debounce.
	// A "contains" search reads megabytes of the trigram index over the network
	// (4.5 MB and 17 s for `xbridg` on the preview), so it runs on submit only.
	useEffect(() => {
		if (!gazetteer || mode !== "prefix") return

		const timer = setTimeout(() => runSearch("prefix", text), DEBOUNCE_MS)

		return () => clearTimeout(timer)
	}, [gazetteer, mode, text, runSearch])

	// Load the place the path names.
	useEffect(() => {
		if (!gazetteer || !ref) return

		const mine = ++placeSequence.current

		Promise.all([
			placeByRef(gazetteer, ref.sprID, ref.nameKey),
			ancestorsOf(gazetteer, ref.sprID),
			placesNamed(gazetteer, ref.nameKey),
		]).then(
			async ([row, ancestors, named]) => {
				if (mine !== placeSequence.current) return

				if (!row) {
					setKeptPlaceError({
						ref,
						value: `No place ${ref.sprID} is filed under the key "${ref.nameKey}" in this gazetteer.`,
					})

					return
				}

				setKeptView({ ref, value: { row, ancestors, siblings: named.filter((other) => other.sprID !== row.sprID) } })
				setBytesRead(await gazetteer.database.bytesRead())
			},
			(error: unknown) => {
				if (mine !== placeSequence.current) return

				setKeptPlaceError({ ref, value: error instanceof Error ? error.message : String(error) })
			}
		)
	}, [gazetteer, ref])

	const placeLink = (target: GazettePlaceRef, label: React.ReactNode, className?: string, current = false) => (
		<a
			href={gazettePlacePath(target)}
			className={className}
			aria-current={current ? "page" : undefined}
			onClick={(event) => {
				if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return

				event.preventDefault()
				navigate(target)
			}}
		>
			{label}
		</a>
	)

	if (openError) {
		return (
			<p className="mw-error" role="alert">
				The gazetteer could not be opened: {openError}
			</p>
		)
	}

	return (
		<div className={styles.page}>
			<form
				className={styles.form}
				onSubmit={(event) => {
					event.preventDefault()
					runSearch(mode, text)
				}}
			>
				<h1 className={styles.title}>Gazette</h1>
				<input
					type="search"
					className={styles.input}
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="A place name, such as Uxbridge"
					aria-label="Place name"
					spellCheck={false}
					autoComplete="off"
				/>
				<div className={styles.meta}>
					<label>
						<input type="radio" name="mode" checked={mode === "prefix"} onChange={() => setMode("prefix")} />
						Starts with
					</label>
					<label>
						<input type="radio" name="mode" checked={mode === "contains"} onChange={() => setMode("contains")} />
						Contains (three letters or more, on Enter, reads several MB)
					</label>
					<button type="submit" className={styles.button} disabled={!gazetteer || searching}>
						Search
					</button>
					<span aria-live="polite">
						{gazetteer ? `Gazetteer ${gazetteer.version}` : "Opening the gazetteer…"}
						{bytesRead !== null ? ` · ${(bytesRead / 1024).toFixed(0)} KB read` : ""}
						{searching ? " · searching…" : ""}
					</span>
				</div>
			</form>

			<div className={styles.columns}>
				<section className={styles.column} aria-label="Results">
					<h2 className={styles.sectionTitle}>
						{groups.length ? `${groups.length} names` : nameKeyOf(text) ? "No names yet" : "Type a name"}
					</h2>
					{searchError ? (
						<p className="mw-error" role="alert">
							{searchError}
						</p>
					) : null}
					<ul className={styles.results}>
						{groups.map((group) => (
							<li key={group.nameKey}>
								{placeLink(
									{ sprID: group.top.sprID, nameKey: group.nameKey },
									<>
										<span className={styles.resultName}>{group.top.name}</span>
										<span className={styles.resultLine}>
											{group.top.placetype} · {group.top.country}
											{group.top.population ? ` · ${formatCount(group.top.population)} people` : ""}
											{group.count > 1 ? ` · ${group.count - 1} more under this name` : ""}
											{nameKeyOf(group.top.name) === group.nameKey ? "" : ` · key ${group.nameKey}`}
										</span>
									</>,
									styles.result,
									ref?.sprID === group.top.sprID
								)}
							</li>
						))}
					</ul>
				</section>

				<section className={styles.column} aria-label="Place">
					{placeError ? (
						<p className="mw-error" role="alert">
							{placeError}
						</p>
					) : null}
					{view ? (
						<PlaceView view={view} placeLink={placeLink} />
					) : ref ? (
						<p className={styles.hint}>Loading the place…</p>
					) : (
						<p className={styles.hint}>Pick a name to read its place, its ancestors and what the resolver sees.</p>
					)}
				</section>
			</div>
		</div>
	)
}

function PlaceView({
	view,
	placeLink,
}: {
	view: PlaceView
	placeLink: (target: GazettePlaceRef, label: React.ReactNode, className?: string) => React.JSX.Element
}): React.JSX.Element {
	const { row, ancestors, siblings } = view
	const reading = resolverReading(row)
	const rankAmongNamed = siblings.filter((other) => other.negRank < row.negRank).length + 1

	const mapHref =
		row.latitude !== null && row.longitude !== null
			? `/@${row.latitude.toFixed(5)},${row.longitude.toFixed(5)},11z?q=${encodeURIComponent(row.name)}`
			: null

	return (
		<article className={styles.place}>
			<header>
				<h2 className={styles.placeName}>{row.name}</h2>
				<p className={styles.placeLine}>
					<span>{row.placetype}</span>
					<span>{row.country}</span>
					<span>
						WOF <code>{row.sprID}</code>
					</span>
					<a href={spelunkerURL(row.sprID)} target="_blank" rel="noreferrer">
						Spelunker
					</a>
					{mapHref ? <a href={mapHref}>Open on the map</a> : null}
				</p>
			</header>

			<dl className={styles.facts}>
				<dt>Population</dt>
				<dd>{formatCount(row.population)}</dd>
				<dt>Importance</dt>
				<dd>{row.importance === null ? "none" : row.importance.toFixed(3)}</dd>
				<dt>Coordinates</dt>
				<dd>
					{row.latitude !== null && row.longitude !== null
						? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}`
						: "none"}
				</dd>
				<dt>Bounding box</dt>
				<dd>{row.bbox ? row.bbox.map((edge) => edge.toFixed(3)).join(", ") : "none"}</dd>
				<dt>Name role</dt>
				<dd>{row.isPrimary ? "primary name" : (row.nameRole ?? "alternate name")}</dd>
				<dt>Region id</dt>
				<dd>{row.regionID || "none"}</dd>
			</dl>

			<section>
				<h3 className={styles.sectionTitle}>Ancestors</h3>
				{ancestors.length ? (
					<ol className={styles.chain}>
						{ancestors.map((ancestor) => (
							<li key={ancestor.sprID}>
								{placeLink(
									{ sprID: ancestor.sprID, nameKey: ancestor.nameKey },
									`${ancestor.name} (${ancestor.placetype})`
								)}
							</li>
						))}
					</ol>
				) : (
					<p className={styles.hint}>The gazetteer records no ancestor for this place.</p>
				)}
			</section>

			<section>
				<h3 className={styles.sectionTitle}>What the resolver sees</h3>
				<dl className={styles.facts}>
					<dt>Key probed</dt>
					<dd className={styles.key}>{reading.nameKey}</dd>
					<dt>Admitted by tags</dt>
					<dd>{reading.selectedByTags.join(", ") || "none"}</dd>
					<dt>Rank among this name</dt>
					<dd>
						{rankAmongNamed} of {siblings.length + 1}
						{siblings.length + 1 >= NAMED_ROW_LIMIT ? "+" : ""} (score {row.negRank.toFixed(3)})
					</dd>
					<dt>Referential</dt>
					<dd>{reading.referential.toFixed(3)}</dd>
					<dt>Exact match</dt>
					<dd>{reading.exactMatch ? "yes, a primary name" : "no, an alternate name the ranking demotes"}</dd>
				</dl>
			</section>

			<section>
				<h3 className={styles.sectionTitle}>Other places under this name</h3>
				{siblings.length ? (
					<ul className={styles.results}>
						{siblings.map((other) => (
							<li key={other.sprID}>
								{placeLink(
									{ sprID: other.sprID, nameKey: other.nameKey },
									<>
										<span className={styles.resultName}>{other.name}</span>
										<span className={styles.resultLine}>
											{other.placetype} · {other.country} · score {other.negRank.toFixed(3)}
											{other.population ? ` · ${formatCount(other.population)} people` : ""}
										</span>
									</>,
									styles.result
								)}
							</li>
						))}
					</ul>
				) : (
					<p className={styles.hint}>This name is filed once.</p>
				)}
			</section>
		</article>
	)
}
