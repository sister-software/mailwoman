import { previewConfig } from "@mailwoman/site-kit/playwright"

// The public data bucket's CORS rule must admit http://localhost:7771.
// On a port it does not admit, the browser refuses every model, gazetteer
// and sprite fetch and the geocoder never becomes ready.
// The docs dev server holds port 7770.
export default previewConfig({ port: 7771, remoteURLVariable: "MAILWOMAN_EARTH_URL" })
