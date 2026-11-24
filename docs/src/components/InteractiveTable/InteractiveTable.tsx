// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Every markdown table on the site, through the `table` entry of `MDXComponents`.
 *
 *   A table with at least {@linkcode MIN_INTERACTIVE_ROWS} body rows gains column sorting
 *   and a text filter once the page hydrates.
 *   The server renders the original markup, so a reader without JavaScript sees the table as written.
 *
 *   Cells keep the React nodes MDX rendered, such as `<Country>`, links and code, and sort by their text.
 */

import useIsBrowser from "@docusaurus/useIsBrowser"
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table"
import {
	Children,
	type ComponentProps,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useId,
	useMemo,
	useState,
} from "react"

import { compareSortKeys, isNumericColumn, type SortKey, sortKeyOf } from "./sort-key"

import styles from "./styles.module.css"

/**
 * The fewest body rows a table needs before it gains controls.
 * A shorter table is read whole.
 */
const MIN_INTERACTIVE_ROWS = 10

interface Cell {
	node: ReactNode
	props: Record<string, unknown>
	text: string
	key: SortKey
}

type ElementWithChildren = ReactElement<{ children?: ReactNode } & Record<string, unknown>>

const elements = (node: ReactNode): ElementWithChildren[] =>
	Children.toArray(node).filter((child): child is ElementWithChildren => isValidElement(child))

/**
 * The text a reader sees in a node.
 *
 * A component with no children, such as `<Country code="US" />` or `<Groupings ids="eu nato" />`,
 * renders its `code`, `codes` or `ids` prop, so that prop is its text.
 */
function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return ""

	if (typeof node === "string" || typeof node === "number") return String(node)

	if (Array.isArray(node)) return node.map(textOf).join("")

	if (isValidElement<{ children?: ReactNode; code?: unknown; codes?: unknown; ids?: unknown }>(node)) {
		const { children, code, codes, ids } = node.props

		if (children != null) return textOf(children)

		return [code, codes, ids].find((value): value is string => typeof value === "string") ?? ""
	}

	return ""
}

function readCells(row: ElementWithChildren): Cell[] {
	return elements(row.props.children).map((cell) => {
		const { children, ...props } = cell.props
		const text = textOf(children)

		return { node: children, props, text, key: sortKeyOf(text) }
	})
}

/**
 * Splits the table's children into a header row and body rows, or returns null for a
 * shape this component doesn't read, such as a table with several header rows.
 */
function readMarkdownTable(children: ReactNode): { head: Cell[]; body: Cell[][] } | null {
	const sections = elements(children)
	const thead = sections.find((section) => section.type === "thead")
	const tbody = sections.find((section) => section.type === "tbody")

	if (!thead || !tbody) return null

	const headRows = elements(thead.props.children)

	if (headRows.length !== 1) return null

	const head = readCells(headRows[0]!)
	const body = elements(tbody.props.children).map(readCells)

	if (body.some((row) => row.length !== head.length)) return null

	return { head, body }
}

/**
 * Renders a markdown table, adding sorting and a filter when it is long enough.
 */
export default function InteractiveTable({ children, ...props }: ComponentProps<"table">): ReactNode {
	// False on the server and on the hydrating render, so both render the original markup.
	const hydrated = useIsBrowser()
	const parsed = useMemo(() => readMarkdownTable(children), [children])

	if (!hydrated || !parsed || parsed.body.length < MIN_INTERACTIVE_ROWS) {
		return <table {...props}>{children}</table>
	}

	return <SortableTable {...props} head={parsed.head} body={parsed.body} />
}

function SortableTable({
	head,
	body,
	...props
}: ComponentProps<"table"> & { head: Cell[]; body: Cell[][] }): ReactNode {
	const [sorting, setSorting] = useState<SortingState>([])
	const [filter, setFilter] = useState("")
	const filterID = useId()

	const columns = useMemo<Array<ColumnDef<Cell[]>>>(
		() =>
			head.map((header, index) => {
				const numeric = isNumericColumn(body.map((row) => row[index]!.key))

				return {
					id: String(index),
					// A blank cell, and a text cell in a numeric column, are handed over as undefined
					// so that `sortUndefined: "last"` keeps them after the values in both directions.
					accessorFn: (row) => {
						const key = row[index]!.key

						return key.kind === "blank" || (numeric && key.kind === "text") ? undefined : key
					},
					header: () => header.node,
					cell: (context) => context.row.original[index]!.node,
					sortUndefined: "last",
					sortingFn: (a, b, id) =>
						compareSortKeys(
							a.getValue<Exclude<SortKey, { kind: "blank" }>>(id),
							b.getValue<Exclude<SortKey, { kind: "blank" }>>(id),
							numeric
						),
				}
			}),
		[head, body]
	)

	// oxlint-disable-next-line react/incompatible-library -- The table instance is read in this render only and never passed to a memoized child.
	const table = useReactTable({
		data: body,
		columns,
		state: { sorting, globalFilter: filter },
		onSortingChange: setSorting,
		onGlobalFilterChange: setFilter,
		// TanStack filters only columns whose first value is a string or a number, and these values are sort keys.
		getColumnCanGlobalFilter: () => true,
		globalFilterFn: (row, columnID, value: string) =>
			row.original[Number(columnID)]!.text.toLowerCase().includes(value.trim().toLowerCase()),
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	})

	const rows = table.getRowModel().rows

	return (
		<div className={styles.wrapper}>
			<div className={styles.controls}>
				<label htmlFor={filterID}>Filter rows</label>
				<input
					id={filterID}
					type="search"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
					className={styles.filter}
				/>
				<span aria-live="polite" className={styles.count}>
					{rows.length} of {body.length} rows
				</span>
			</div>
			<table {...props}>
				<thead>
					<tr>
						{table.getHeaderGroups()[0]!.headers.map((header) => {
							const direction = header.column.getIsSorted()
							const original = head[Number(header.column.id)]!

							return (
								<th
									key={header.id}
									{...original.props}
									aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
								>
									<button type="button" className={styles.sort} onClick={header.column.getToggleSortingHandler()}>
										{flexRender(header.column.columnDef.header, header.getContext())}
										<span aria-hidden="true" className={styles.indicator}>
											{direction === "asc" ? "▲" : direction === "desc" ? "▼" : "↕"}
										</span>
									</button>
								</th>
							)
						})}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id}>
							{row.getVisibleCells().map((cell) => (
								<td key={cell.id} {...row.original[Number(cell.column.id)]!.props}>
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
