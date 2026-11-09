/**
 * The catalog ids a client names in `capabilities.uiResources.catalogs`
 * (guuey#2386), spelled once. `A2UI_CAPABILITIES` advertises them, and
 * `@guuey/chat`'s A2UI reader and json-render adapter read and write them.
 * React-free, so the chat's pure A2UI modules can import it.
 */

/** guuey's own A2UI catalog (advisory on the wire: any non-empty `catalogId` is accepted and components draw by name). */
export const A2UI_GUUEY_CATALOG_ID = "guuey.a2ui.v1";

/** The catalog a json-render spec's mapped surface is created under. */
export const JSON_RENDER_CATALOG_ID = "guuey.json-render.v1";
