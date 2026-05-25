/**
 * `guuey.json#ggui` — optional cross-protocol integration section.
 *
 * Reserved for projects that use the ggui protocol (mcp.ggui.ai) for
 * rendering. The actual ggui-app identity (slug, gadgets, publicEnv,
 * etc.) lives in a separate `ggui.json` file owned by the ggui
 * ecosystem (`@ggui-ai/project-config`). This section provides the
 * reference from `guuey.json` to that sibling file.
 *
 * Two reference forms:
 *
 * - **File path** — `{ configFile: './ggui.json' }` resolves the sibling
 *   file at deploy time. Recommended for most projects.
 * - **Inline** — `{ inline: { ...ggui-json-fields } }` for projects that
 *   prefer a single config file. Schema validation defers to the ggui
 *   ecosystem (we only type the wrapper).
 *
 * Cross-ecosystem boundary: guuey-side does NOT validate the ggui section's
 * contents. The platform is MCP-server-agnostic — agents can use
 * `mcp.ggui.ai` and get rendering for free, or use a different MCP server
 * and skip this section entirely.
 */
import { z } from 'zod';

/**
 * The ggui integration section schema. Mutually exclusive forms:
 * `configFile` reference OR `inline` object. Both optional — projects
 * that don't use ggui rendering omit the whole `ggui` block.
 */
export const GguiSectionV1 = z
  .strictObject({
    configFile: z.string().min(1).optional(),
    /**
     * Inline ggui config (opaque to this package). The actual schema
     * lives in `@ggui-ai/project-config`; we type it as a record here
     * to avoid coupling the OSS guuey config package to the ggui SDK.
     */
    inline: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (val) => !(val.configFile && val.inline),
    { message: '`ggui` cannot specify both `configFile` and `inline` — pick one' },
  );

/** Static TypeScript type for the ggui integration section. */
export type GuueyGguiSection = z.infer<typeof GguiSectionV1>;
