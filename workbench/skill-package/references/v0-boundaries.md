# Current capability boundaries

This package contains a real local image-comparison workflow, not the earlier fixed-data prototype. Its output remains heuristic and requires human review.

## What works now

- Starts the workbench and a token-protected source bridge on `127.0.0.1` using a dynamic port.
- Accepts PNG, JPEG, and WebP design and implementation images through click-to-select or role-specific single-file drag-and-drop.
- Imports one Figma frame as PNG from a `design` or `file` URL with a `node-id`, using a temporary PAT supplied in the request or `FIGMA_ACCESS_TOKEN` from the launcher environment.
- Captures a specified viewport of an HTTP(S) page using an isolated temporary Chrome, Chromium, or Edge profile when a supported executable is installed.
- Compares decoded images in a browser Worker using deterministic max-width normalization, a coarse input-comparability gate, pixel/edge heuristics, mobile status-bar exclusion, conservative candidate classification, and spatial grouping. The narrower source is proportionally enlarged to the wider source width before comparison.
- Stops low-comparability pairs before local classification, warns on medium-comparability pairs, treats one-sided transparent pixels as region-presence evidence only, and uses neutral content/visual labels where raster evidence cannot support a component role.
- Shows real source images in comparison views and connects generated candidates to list/detail review, status changes, notes, filtering, and export.
- Cancels an active analysis and clears stale results when either source changes.

## What the result means

The engine detects and classifies visible pixel and contour differences. Types such as color, size, position, text, radius, shadow, border, icon, layout, and content are heuristic interpretations of raster evidence. The engine does not know product intent or inspect the implementation source. A content label means only that a localized visual region changed in a way that is unsafe to describe as UI geometry; it does not identify the cause.

Treat every result as a **candidate**, not a confirmed defect. A person must verify source equivalence and rule out rendering noise, dynamic content, responsive differences, stale design, and intentional implementation changes. Confidence, severity, priority, and review status are separate concepts.

## Source-import limits

### Figma

- Uses a personal access token and Figma's image export API; there is no OAuth or account-linking flow.
- Imports only the frame/node named by the URL. It does not inherit a browser login, browse a Figma file, enumerate frames, inspect components, read variables, extract tokens, or parse prototype interactions.
- A PAT typed into the workbench is used for that import request and is not persisted by the launcher. A `FIGMA_ACCESS_TOKEN` environment variable remains available to the launcher process for its lifetime.
- The request leaves the machine to contact Figma, and the selected frame PNG is downloaded to the local workbench response.

### Web capture

- Starts a new headless Chromium-family process with a temporary user-data directory and extensions disabled.
- Does not reuse the user's Chrome profile, cookies, extensions, open tabs, authenticated sessions, or browser storage.
- Captures only the requested current viewport. It does not scroll and stitch a full page, interact with the page, complete authentication, select application state, or inherit an already-open browser state.
- Does not inspect the DOM, accessibility tree, source code, layout boxes, network log, or computed styles.
- The target site receives an ordinary request from the isolated browser and may render differently because no existing session is present.

## Analysis limits

- No OCR or semantic understanding of text; “text” findings are inferred from raster shape and density.
- The input-comparability score is not calibrated against a labelled production data set. It can detect broad mismatch patterns but cannot prove route/state/content equivalence, decide which image is correct, or reliably distinguish every full-screen photo from a fully changed UI.
- No component matching, DOM-to-design mapping, computed-style evidence, design-token comparison, or responsive breakpoint crawl.
- No automatic masking of arbitrary dynamic regions, animation synchronization, font-installation repair, or content normalization.
- Alignment uses a deterministic raster rule: choose the wider source width, leave that source at 1×, proportionally enlarge only the narrower source, then top-left align both normalized images on a canvas tall enough for either source. It does not perform feature registration, perspective correction, non-uniform stretching, or silent cropping.
- Width normalization corrects raster-size or export-scale differences; it does not prove that screenshots from different responsive breakpoints are semantically equivalent.
- No automated UX heuristic review, accessibility audit, keyboard/focus inspection, or multi-step flow critique in the current release.
- No persistent projects, accounts, cloud storage, collaboration, shared comments, or remote job execution.
- The normalized comparison canvas is limited to 32 million pixels. If max-width enlargement would exceed that limit, the workbench blocks analysis and asks for screenshots with closer dimensions or a prior crop.

## Privacy and security language

Local image decoding and comparison stay in the browser session. The launcher binds only to loopback, validates Host and Origin for bridge writes, and requires a per-launch token for source APIs. The token is carried in the launch URL fragment and is not sent to unrelated servers by normal URL navigation.

These controls reduce exposure but are not a formal security audit or end-to-end privacy guarantee. Figma import and webpage capture necessarily contact external services. Browser extensions, developer tools, a modified bundle, environment variables, local malware, or future integrations can change the boundary.

## Requirements and failure conditions

- Local image comparison requires browser support for Workers, `createImageBitmap`, and `OffscreenCanvas`.
- Figma import requires a valid PAT, a URL with one valid `node-id`, and network access to Figma.
- Web capture requires an installed supported Chrome/Chromium/Edge executable and a target page that renders without inherited login state.
- If either integration is unavailable, report the exact capability or launcher error and use a local exported image as the fallback. Do not pretend an import or capture succeeded.
