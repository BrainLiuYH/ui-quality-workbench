---
name: ui-quality-workbench
description: Launch Design Toolbox (设计工具箱), a local platform for UI screenshot inspection and a collection of useful tools and Skills. Use when the user wants to open the toolbox, browse shared tools and copy installation prompts, or compare design and implementation screenshots followed by human review and export of heuristic difference candidates. Screenshot sources include local images, a Figma frame imported with a personal access token, or an isolated Chromium viewport capture. This version is not a UX, accessibility, DOM, or computed-style audit.
---

# 设计工具箱 · Design Toolbox

Use this skill to open **设计工具箱**. The platform includes **UI 走查** and **工具分享**. Its installation identifier remains `ui-quality-workbench` so existing installs and launch commands keep working.

The UI 走查 module compares a design image with an implementation screenshot in a browser Worker, groups visible differences into review candidates, and supports human confirmation and export.

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

## Browse shared tools

Select **工具分享** in the left navigation to browse the collected tools and Skills. The initial entries are Cowart and `ui-wireframe-workflow`. Click a card for its introduction, or select **一键安装** to open a copyable installation prompt. Send that prompt to a compatible AI tool to perform installation; the browser itself only displays and copies the prompt.

Cowart uses its public repository as the installation source. The wireframe Skill prompt includes all four required Markdown files, so recipients do not need access to the sharer's computer. Collection badges do not indicate whether a visitor has installed a tool.

## Choose sources for UI inspection

The workbench needs one design image and one implementation image. Each source change invalidates earlier results; run the audit again after replacing either source.

- **Local image:** click to select or drag one PNG, JPEG, or WebP into the matching design/implementation area. Decoding, raster comparison, and grouping stay in the local browser session.
- **Figma frame:** provide a Figma `design` or `file` URL containing one `node-id`, plus a personal access token (PAT), or start the launcher with `FIGMA_ACCESS_TOKEN`. This imports a PNG rendering of that frame through Figma's API; it does not browse the file or inherit a Figma login.
- **Web capture:** provide an HTTP(S) URL, viewport dimensions, and optional render wait. The bridge starts a temporary headless Chrome/Chromium/Edge profile and captures that viewport. It does not inherit the user's browser profile, cookies, extensions, or authenticated session.

Read [references/source-imports.md](references/source-imports.md) before operating or troubleshooting Figma import or web capture.

## Run and review an audit

1. Confirm that both sources represent the same route, UI state, locale, content, viewport, and scroll position as closely as possible.
2. Check the displayed comparison-scale choice. For close-width mobile captures the app *suggests* “原像素·同密度”: it keeps both images at 1× and compares their overlapping viewport only. This is not proof of identical device pixel ratio; confirm the device/export scale yourself. If the files differ only in export scale, switch to “等比缩放·同宽” so only the narrower image is proportionally enlarged to the wider width. This choice changes preview and analysis together and invalidates old results. Top alignment checks the shared top area; switch to bottom alignment to check a footer fixed to the viewport bottom. Different responsive viewport sizes must not produce an actionable defect solely because one screenshot extends beyond the other.
3. Start the audit. Before local classification, the Worker checks whether the normalized rasters are suitable for direct comparison. A low-comparability pair stops without generating candidates; a medium-comparability pair continues with an explicit warning. This is a conservative heuristic gate, not a probability or a semantic judgment about which image is correct.
4. Inspect candidates in the visual comparison, list, and detail panel. One-sided transparent content is reported only as a region-presence/layout difference. Ambiguous media or content changes use neutral wording instead of being forced into color, text, icon, or geometry defects. Check whether anti-aliasing, font loading, animation, dynamic data, responsive behavior, or stale design explains the difference.
   For screenshots with different solid page backgrounds, the Worker reports one background-color candidate and excludes that uniform offset from component segmentation. Large matching light cards are compared by their exterior bounds before their dynamic text. A broad solid accent in the lower navigation area and a top-right dark status badge can produce localized candidates. On matched full-height screenshots, the bottom bar's outer position, visible background treatment, and selected subcontrol may be separate findings; static pixels do not prove the CSS blur or opacity setting. These are image heuristics, not DOM or component recognition: inspect the marked pixels before confirming them. Different photos, timestamps, and text shapes alone do not prove element size or placement; subtle corner radii and exact font sizes still need manual or source-level verification.
5. Confirm only verified candidates. Require a reason when intentionally ignoring a real difference or dismissing a false positive.
6. Assign severity and priority independently, then export the reviewed list. Do not infer priority from pixel area or color distance alone.

Read [references/audit-classification.md](references/audit-classification.md) when classifying a visual difference. This workbench-owned taxonomy supersedes upstream Yangao category priorities and universal pixel thresholds. Read [references/audit-model.md](references/audit-model.md) when prioritizing, changing review status, or deciding what to export. Read [references/v0-boundaries.md](references/v0-boundaries.md) before explaining privacy, supported integrations, capture behavior, or analytical limitations.

When a user points out a missed finding or a false positive, read [references/audit-feedback-cases.md](references/audit-feedback-cases.md) before changing the detector. Record the observation and competing explanations, decide what the screenshots actually establish, then add both a positive and a counterexample regression test for any new automatic rule. Recheck the supplied pair when it is available. Mark unverified cases as open rather than teaching the engine a screenshot-specific coordinate or claiming accuracy has improved without a comparison set. Do not bundle private user screenshots in the distributable Skill.

## Keep claims accurate

- The comparison engine is adapted from `SemineChen/yangao` at fixed commit `beac836ba3c81b9a1d40bac8fe75af08444ab742`, under the author's permission as reported by the user. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Figma import requires a PAT and outbound access to Figma. It is not OAuth, account linking, design-token extraction, or general Figma file parsing.
- Web capture is an isolated current-viewport screenshot. It is not full-page stitching, interactive browsing, login-state inheritance, DOM inspection, or computed-style extraction.
- Local browser processing is not a security certification. Figma import necessarily sends the PAT to Figma and downloads the selected frame; webpage capture necessarily requests the supplied URL.
- The comparability gate has no OCR, DOM, or product semantics. It can stop widely mismatched inputs and warn about localized changes, but it cannot prove that two screens represent the same route/state or identify the authoritative side.
- UI 走查 and 工具分享 are implemented. Do not claim that the planned interaction-experience, accessibility, or collaboration modules already run.
