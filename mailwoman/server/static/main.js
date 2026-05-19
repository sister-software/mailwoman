/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AnsiUp } from "ansi_up"

const converter = new AnsiUp()

converter.use_classes = true

const mainTable = /** @type {HTMLTableElement} */ (document.getElementById("table"))
const debugContainer = /** @type {HTMLDivElement} */ (document.getElementById("debug"))
const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("text"))
const searchForm = /** @type {HTMLFormElement} */ (document.getElementById("search"))

/**
 * @param {import("mailwoman/server").ParseAddressResponse} response
 */
function render(response) {
	mainTable.innerHTML = ""
	debugContainer.innerHTML = ""

	const tableHeader = document.createElement("thead")
	const headerRow = document.createElement("tr")

	const columnHeader = document.createElement("th")
	columnHeader.classList.add("score")

	columnHeader.textContent = "Score"

	headerRow.append(columnHeader)

	mainTable.append(tableHeader)

	const tableBody = document.createElement("tbody")

	for (let characterIndex = response.input.start; characterIndex < response.input.end; characterIndex++) {
		const cell = document.createElement("th")

		let char = response.input.body.charAt(characterIndex)
		if (char.trim().length > 0) {
			cell.classList.add("kb")
		} else {
			char = String.fromCharCode(160)
		}
		cell.textContent = char
		headerRow.append(cell)
	}

	tableHeader.append(headerRow)

	response.solutions.forEach((solution) => {
		const solutionRow = document.createElement("tr")

		const solutionHeader = document.createElement("th")
		solutionHeader.classList.add("score")
		solutionHeader.textContent = (solution.score * 100).toFixed(1) + "%"

		solutionRow.append(solutionHeader)

		for (let i = response.input.start; i < response.input.end; i++) {
			const cell = document.createElement("td")

			let spanStart = false

			/**
			 * @type {import("mailwoman").SerializedSolutionMatch | undefined}
			 */
			let currentSolutionPair

			const { matches } = solution

			for (let j = 0; j < matches.length; j++) {
				const pair = matches[j]

				if (pair.start === i) {
					spanStart = true

					currentSolutionPair = pair
				}
			}

			if (spanStart && currentSolutionPair) {
				const covers = currentSolutionPair.end - currentSolutionPair.start

				cell.colSpan = covers
				cell.classList.add("span", "span-" + currentSolutionPair.classification)
				cell.textContent = currentSolutionPair.classification

				i += covers - 1
			} else {
				cell.textContent = String.fromCharCode(160)
			}

			solutionRow.append(cell)
		}

		tableBody.append(solutionRow)
	})

	mainTable.append(tableBody)

	const tableFooter = document.createElement("tfoot")

	const footerRow = document.createElement("tr")

	const footerHeader = document.createElement("th")
	footerHeader.classList.add("score")
	footerHeader.textContent = "Average"

	footerRow.append(footerHeader)

	const totalCell = document.createElement("td")
	totalCell.colSpan = response.input.body.length
	totalCell.textContent =
		(
			response.solutions.reduce((acc, solution) => {
				return acc + solution.score
			}, 0) / response.solutions.length
		).toFixed(2) + "%"

	footerRow.append(totalCell)

	tableFooter.append(footerRow)

	mainTable.append(tableFooter)

	if (response.debug) {
		const debugHtml = converter.ansi_to_html(response.debug)
		debugContainer.innerHTML = debugHtml
	}
}

/**
 * @param {string} address
 * @param {RequestInit} [options]
 *
 * @returns {Promise<import("mailwoman/server").ParseAddressResponse>}
 */
function performAddressLookup(address, options) {
	saveText(address)

	return fetch("/parse", {
		method: "SEARCH",

		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			address,
			debug: true,
		}),
		...options,
	})
		.then((res) => {
			if (!res.ok) {
				throw new Error("HTTP error " + res.status + " " + res.statusText)
			}

			return res.json()
		})
		.catch((error) => console.error(error))
}

/**
 * @param {string} address
 */
function saveText(address) {
	if (!address || address === "undefined") {
		window.localStorage.removeItem("text")
	}

	window.localStorage.setItem("text", address)
}

/**
 * @returns {string}
 */
function loadAddress() {
	let hash = window.location.hash

	if (hash && hash.length) {
		if (hash[0] === "#") {
			hash = hash.slice(1)
		}

		if (hash.length) {
			return decodeURIComponent(hash)
		}
	}

	if (window.localStorage) {
		const text = window.localStorage.getItem("text")

		if (text && text !== "undefined") {
			return text
		}
	}

	return "1389a County Road 42 IA"
}

let updateID = null
let controller = new AbortController()

function update() {
	clearTimeout(updateID)
	controller.abort()

	controller = new AbortController()

	updateID = setTimeout(async () => {
		const nextAddress = searchInput.value.trim()

		if (!nextAddress) return

		const results = await performAddressLookup(nextAddress, {
			// signal: controller.signal,
		})

		render(results)

		window.location.hash = encodeURIComponent(nextAddress)
	}, 200)

	return false
}

searchForm.addEventListener("submit", update)
searchInput.addEventListener("keyup", update)

const text = loadAddress()

if (text) {
	searchInput.value = text
	update()
}
