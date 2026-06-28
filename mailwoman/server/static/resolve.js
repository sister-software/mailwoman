/**
 * Mailwoman resolver-demo front-end. No framework, no build step — vanilla DOM against the `/api/resolve` endpoint
 * exposed by `ResolveRouter.ts`.
 */

const $form = /** @type {HTMLFormElement} */ (document.getElementById("resolve-form"))
const $input = /** @type {HTMLInputElement} */ (document.getElementById("text"))
const $button = /** @type {HTMLButtonElement} */ ($form.querySelector("button"))
const $status = /** @type {HTMLElement} */ (document.getElementById("status"))
const $results = /** @type {HTMLElement} */ (document.getElementById("results"))
const $xmlEl = /** @type {HTMLPreElement} */ (document.getElementById("xml"))
const $nodesBody = /** @type {HTMLTableSectionElement} */ (document.getElementById("nodes-body"))

/**
 * @param {"loading" | "error"} kind
 * @param {string} message
 */
function showStatus(kind, message) {
	$status.hidden = false
	$status.className = `status ${kind}`
	$status.textContent = message
}

function clearStatus() {
	$status.hidden = true
	$status.textContent = ""
}

/**
 * @param {number} n
 *
 * @returns {string}
 */
function pad(n) {
	return String(Math.round(n * 1000) / 1000)
}

/**
 * Build the depth-indented tag display — visual hierarchy without `<ul>` nesting.
 *
 * @param {number} depth
 */
function indent(depth) {
	const span = document.createElement("span")
	span.className = "depth-indent"
	span.textContent = depth === 0 ? "" : `${"·  ".repeat(depth)}`

	return span
}

/**
 * @param {import("../ResolveRouter.js").ResolveResponseNode} node
 */
function renderRow(node) {
	const tr = document.createElement("tr")

	if (node.source === "resolver") tr.classList.add("resolved")

	const tagTd = document.createElement("td")
	tagTd.append(indent(node.depth))
	const tagSpan = document.createElement("span")
	tagSpan.className = "tag"
	tagSpan.textContent = node.tag
	tagTd.append(tagSpan)
	tr.append(tagTd)

	const valueTd = document.createElement("td")
	valueTd.textContent = node.value
	tr.append(valueTd)

	const confTd = document.createElement("td")
	confTd.textContent = node.confidence.toFixed(2)

	if (node.confidence < 0.6) confTd.className = "conf-low"
	tr.append(confTd)

	const sourceTd = document.createElement("td")
	const srcParts = [node.source, node.sourceId].filter(Boolean)
	sourceTd.textContent = srcParts.join(":") || "—"
	tr.append(sourceTd)

	const placeTd = document.createElement("td")
	placeTd.className = "place"
	placeTd.textContent = node.placeId || "—"
	tr.append(placeTd)

	const latTd = document.createElement("td")
	latTd.textContent = node.lat !== undefined ? pad(node.lat) : "—"
	tr.append(latTd)

	const lonTd = document.createElement("td")
	lonTd.textContent = node.lon !== undefined ? pad(node.lon) : "—"
	tr.append(lonTd)

	return tr
}

/**
 * @param {import("../ResolveRouter.js").ResolveResponse} response
 */
function render(response) {
	clearStatus()
	$results.hidden = false

	$xmlEl.textContent = response.xml

	$nodesBody.innerHTML = ""

	for (const node of response.nodes) {
		$nodesBody.append(renderRow(node))
	}
}

async function submit() {
	const text = $input.value.trim()

	if (!text) return

	$button.disabled = true
	showStatus("loading", "Resolving…")

	try {
		const r = await fetch("/api/resolve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		})
		const data = await r.json()

		if (!r.ok) {
			showStatus("error", data?.error ?? `HTTP ${r.status}`)
			$results.hidden = true

			return
		}
		render(data)
	} catch (err) {
		showStatus("error", `Request failed: ${err instanceof Error ? err.message : String(err)}`)
		$results.hidden = true
	} finally {
		$button.disabled = false
	}
}

$form.addEventListener("submit", (e) => {
	e.preventDefault()
	void submit()
})

// Pre-fill from `?text=` query string for shareable links.
const urlText = new URLSearchParams(window.location.search).get("text")

if (urlText) {
	$input.value = urlText
	void submit()
}
