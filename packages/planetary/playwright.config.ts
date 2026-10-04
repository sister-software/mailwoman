import { previewConfig } from "@mailwoman/universe/site-kit/playwright"

// The public data bucket's CORS rule must admit http://localhost:7771, the port the Earth preview also uses.
// On a port it does not admit, the browser refuses the glyph and search-artifact fetches,
// labels never draw and search never loads.
// The two previews never run at once: CI runs the Earth smoke, then one planetary smoke per body.
// The docs dev server holds port 7770.
export default previewConfig({ port: 7771, remoteURLVariable: "MAILWOMAN_PLANETARY_URL" })
