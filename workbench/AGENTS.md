# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

## Confirmed visual direction

- The user selected the third ideation option on 2026-08-26.
- Preserve its audit-session workbench structure: compact left navigation, comparison evidence above a findings table, and a persistent right-side decision inspector.
- On 2026-08-26 the user approved the refined Fluent + Ant direction shown in `../design-previews/selected-fluent-ant-direction.png`; this supersedes the earlier grayscale-only styling.
- Use a light blue-gray application shell, white working surfaces, cobalt-blue active and primary states, compact enterprise density, 8–10px control radii, 10px panel radii, fine cool-gray borders, and restrained low elevation. Keep amber limited to Beta/warning semantics.
- Local image input must support both click-to-select and single-file drag-and-drop. The main empty design/implementation placeholders and the matching zones in the upload dialog should visibly highlight during a valid file drag while keeping each role unambiguous.
- Before raster comparison, use the wider source width as the target width. Keep the wider image at 1×, proportionally enlarge only the narrower image to that width, top-left align both normalized images, and preserve any resulting bottom height difference as comparison evidence. Never non-uniformly stretch or silently crop either source.
- Before classifying local differences, run an input-comparability gate on the normalized rasters. Low-comparability pairs must stop without generating a misleading issue list; medium-comparability pairs may continue only with a persistent human-review warning. Never present the gate score as a calibrated probability.
- Treat one-sided transparent pixels as a single region-presence/layout candidate. Transparent RGB bytes are not black content and must not generate color, text, icon, border, shadow, or size claims.
- Require positive raster evidence before assigning text, icon, or media roles. Use neutral names for ambiguous or slender fragments, keep localized media/content changes separate from UI geometry claims, and prefer one primary objective classification per visual object over several contradictory types.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
