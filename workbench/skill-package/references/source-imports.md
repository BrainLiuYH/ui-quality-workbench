# Source imports

Read this reference when importing a Figma frame, capturing an implementation URL, or explaining why an imported source differs from what the user sees elsewhere.

## Local images

Local PNG, JPEG, and WebP files are the most deterministic inputs. They can be selected with the file picker or dragged one at a time into the matching design/implementation placeholder or upload-dialog zone. Prefer exported images when authentication, dynamic content, browser-specific rendering, or unsupported integrations would make automated import unreliable.

Keep the two roles explicit: dropping on the design area must not replace the implementation source, and vice versa. Reject empty, unsupported, oversized, or multi-file drops without changing an existing source. A replacement becomes active only after it decodes successfully.

Before comparing, check that both images represent the same:

- route and scroll position;
- viewport size and device-pixel ratio;
- UI state, locale, data, and feature flags;
- loaded fonts and images;
- animation or transition frame.

Replacing either image invalidates previous candidates and review state.

Before comparison, the engine normalizes width deterministically: it chooses the wider image width as the target, leaves that image at 1×, and proportionally enlarges only the narrower image to match. The normalized images are top-left aligned without stretching or cropping. If their proportional heights still differ, the common comparison canvas keeps the full taller image and treats the unmatched bottom area as visible difference evidence.

This rule handles different raster widths or export scale factors. It cannot make different routes, responsive breakpoints, states, content, or scroll positions equivalent, so the source checks above still apply.

After normalization, the engine performs a coarse input-comparability check before classifying local regions. Widely distributed strong pixel and structural changes can stop the audit with no issue candidates. Localized media changes or unmatched bottom height normally produce a medium warning instead of automatically rejecting the whole pair. The gate has no OCR or route/state awareness, so correct source selection remains the user's responsibility.

The resulting common canvas is limited to 32 million pixels. If enlarging a narrow, very tall image to the wider source would exceed that boundary, use inputs with closer dimensions or crop both sources to the intended review region; do not stretch, shrink, or silently crop them inside the analyzer.

## Figma frame import

The importer accepts HTTPS URLs whose path starts with `/design/` or `/file/` and whose query contains exactly one `node-id`. It exports that node as PNG through Figma's API.

Use one of these token paths:

- enter a PAT in the workbench for the current import request; or
- set `FIGMA_ACCESS_TOKEN` before starting the launcher when repeated imports are needed in the same local process.

The PAT must have access to the requested file. Do not ask the user to paste it into chat, logs, source code, exported findings, or screenshots. The local UI should send it only to the loopback bridge, which uses it to contact Figma.

This is frame-image import only. It does not provide OAuth, file browsing, account login, component metadata, variables, styles, Code Connect information, design tokens, or prototype interactions.

If import fails, report the specific cause: malformed URL or missing `node-id`, missing/invalid PAT, file permission, Figma/network failure, oversized export, or an invalid PNG response. Offer a local frame export as the fallback.

## Web viewport capture

The capture bridge accepts an HTTP(S) URL, viewport width and height, and an optional render wait. Capability discovery reports whether a supported Chrome, Chromium, or Edge executable is available.

Each capture uses a new temporary browser profile with extensions disabled and device scale factor 1. This isolation makes captures more reproducible, but it also means the page receives no cookies, saved login, extension behavior, local storage, or state from the user's normal browser.

The output is the requested current viewport only. It is not a full-page screenshot and does not scroll, click, sign in, dismiss dialogs, choose app state, or reuse an open tab. For a private or stateful page, ask the user to provide a local screenshot instead of implying that capture can inherit authentication.

Choose viewport dimensions that match the design frame. Use the render wait only to allow an otherwise public page to finish ordinary loading; it is not a reliable synchronization mechanism for arbitrary animations or data.

If capture fails, distinguish among: no supported browser, invalid URL or viewport, browser start failure, page/render timeout, and incomplete or oversized PNG. Do not silently substitute a different viewport or source.

## Provenance to retain

For reliable review and export, retain or record where practical:

- source kind: local, Figma frame, or captured URL;
- original filename, Figma node URL, or page URL;
- pixel dimensions and capture viewport;
- capture wait and timestamp for a webpage;
- comparison profile and engine version/source commit;
- input-comparability status, reasons, and uncalibrated diagnostic metrics.

Do not place PAT values, launch tokens, cookies, or other credentials in provenance or exports.
