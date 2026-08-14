/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

const AllowedOrigins: ReadonlySet<string> = new Set([
	"https://mailwoman.sister.software",
	"https://sister.software",
	"https://dev.sister.software",
	"https://dev.sister.software:7777",
	"https://dev.sister.software:8888",
	"http://dev.sister.software:7777",
	"http://dev.sister.software:8888",
	"http://localhost:7770",
	"https://maplibre.org",
])

const SerializedAccessControlHeaders = [
	// ---
	"Accept-Ranges",
	"If-Match",
	"If-Modified-Since",
	"If-None-Match",
	"Range",
	"Server",
	"x-goog-meta-frames",
	"X-Mailwoman-Request",
	"X-Mailwoman-Response",
	"X-Requested-With",
].join(", ")

const LOCALHOST_PATTERN = /^https?:\/\/(([a-z0-9]+\.)?localhost)(:\d{4,5})?$/i
const VSCODE_WEBVIEW_PROTOCOL = "vscode-webview:"

export function applyAccessControlAllowOrigin(request: Request, response: Response): void {
	if (AllowedOrigins.has("*")) {
		response.headers.set("Access-Control-Allow-Origin", "*")
	} else {
		const requestOrigin = request.headers.get("Origin")

		if (!requestOrigin) return

		const permittedOrigin =
			AllowedOrigins.has(requestOrigin) || // Known origin?
			LOCALHOST_PATTERN.test(requestOrigin) || // Local development?
			requestOrigin.startsWith(VSCODE_WEBVIEW_PROTOCOL)

		// Coming from a VSCode webview?

		if (!permittedOrigin) return

		response.headers.set("Access-Control-Allow-Origin", requestOrigin)
	}

	response.headers.set("Access-Control-Allow-Headers", SerializedAccessControlHeaders)
	response.headers.set("Access-Control-Expose-Headers", "*")
	response.headers.set("Vary", "Origin")
}
