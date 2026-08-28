---
name: ui-quality-workbench
description: Launch and operate a local UI quality workbench for real design-versus-implementation screenshot comparison. Use when the user wants UI fidelity inspection from local images, a Figma frame imported with a personal access token, or an isolated Chromium viewport capture, followed by human review and export of heuristic difference candidates. This version is not a UX, accessibility, DOM, or computed-style audit.
---

# UI Quality Workbench

Use this skill to run the local **UI 走查** module. It compares a design image with an implementation screenshot in a browser Worker, groups visible differences into review candidates, and supports human confirmation and export.

The analyzer is heuristic. Call its output **candidates** or **possible mismatches** until a person verifies the intended design, route, state, content, and viewport. Never present an unreviewed result as a confirmed defect.

## Start the workbench

1. Resolve this skill's directory from the selected `SKILL.md`. Do not assume the repository root or hardcode an install location.
2. Verify the bundle and local source bridge before the first launch in a session:

   ```bash
   python3 <skill-directory>/scripts/serve_workbench.py --check
   ```

3. Start the server as a long-running process:

   ```bash
   python3 <skill-directory>/scripts/serve_workbench.py
   ```

   The launcher prints one JSON line with `event: "ready"`, `protocol: 2`, a dynamic loopback URL, and process metadata. Use the returned URL exactly; its fragment carries the per-launch token used by the browser app.

4. If browser control is available and the user wants the interface opened, navigate to that URL. Otherwise, give the URL to the user.
5. Keep the process running while the workbench is in use. Stop it with `Ctrl+C` when the user asks to close it or the session no longer needs it.

If launch fails with `EPERM` or an explicit loopback-socket restriction, request local execution permission and retry the same command. Do not change the bind address, substitute a hosted copy, or upload local images elsewhere.

## Choose sources

The workbench needs one design image and one implementation image. Each source change invalidates earlier results; run the audit again after replacing either source.

- **Local image:** click to select or drag one PNG, JPEG, or WebP into the matching design/implementation area. Decoding, raster comparison, and grouping stay in the local browser session.
- **Figma frame:** provide a Figma `design` or `file` URL containing one `node-id`, plus a personal access token (PAT), or start the launcher with `FIGMA_ACCESS_TOKEN`. This imports a PNG rendering of that frame through Figma's API; it does not browse the file or inherit a Figma login.
- **Web capture:** provide an HTTP(S) URL, viewport dimensions, and optional render wait. The bridge starts a temporary headless Chrome/Chromium/Edge profile and captures that viewport. It does not inherit the user's browser profile, cookies, extensions, or authenticated session.

Read [references/source-imports.md](references/source-imports.md) before operating or troubleshooting Figma import or web capture.

## Run and review an audit

1. Confirm that both sources represent the same route, UI state, locale, content, viewport, and scroll position as closely as possible.
2. Check the displayed normalization preview. The engine uses the wider source as the target width, keeps it at 1×, proportionally enlarges only the narrower source to that width, then top-left aligns both images. It does not stretch or crop either source, and a remaining bottom height difference stays in the comparison.
3. Start the audit. Before local classification, the Worker checks whether the normalized rasters are suitable for direct comparison. A low-comparability pair stops without generating candidates; a medium-comparability pair continues with an explicit warning. This is a conservative heuristic gate, not a probability or a semantic judgment about which image is correct.
4. Inspect candidates in the visual comparison, list, and detail panel. One-sided transparent content is reported only as a region-presence/layout difference. Ambiguous media or content changes use neutral wording instead of being forced into color, text, icon, or geometry defects. Check whether anti-aliasing, font loading, animation, dynamic data, responsive behavior, or stale design explains the difference.
5. Confirm only verified candidates. Require a reason when intentionally ignoring a real difference or dismissing a false positive.
6. Assign severity and priority independently, then export the reviewed list. Do not infer priority from pixel area or color distance alone.

Read [references/audit-model.md](references/audit-model.md) when classifying, prioritizing, changing review status, or deciding what to export. Read [references/v0-boundaries.md](references/v0-boundaries.md) before explaining privacy, supported integrations, capture behavior, or analytical limitations.

## Keep claims accurate

- The comparison engine is adapted from `SemineChen/yangao` at fixed commit `beac836ba3c81b9a1d40bac8fe75af08444ab742`, under the author's permission as reported by the user. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Figma import requires a PAT and outbound access to Figma. It is not OAuth, account linking, design-token extraction, or general Figma file parsing.
- Web capture is an isolated current-viewport screenshot. It is not full-page stitching, interactive browsing, login-state inheritance, DOM inspection, or computed-style extraction.
- Local browser processing is not a security certification. Figma import necessarily sends the PAT to Figma and downloads the selected frame; webpage capture necessarily requests the supplied URL.
- The comparability gate has no OCR, DOM, or product semantics. It can stop widely mismatched inputs and warn about localized changes, but it cannot prove that two screens represent the same route/state or identify the authoritative side.
- UI 走查 is the implemented module. Do not claim that the planned interaction-experience, accessibility, or collaboration modules already run.
