# Design QA

## Target

- Reference: `../design-previews/selected-fluent-ant-direction.png`
- Reference normalized from 1487×1058 to 1440×1024 for comparison.
- Implementation state: default audit, side-by-side mode, issue 1 selected, zoom 100%.
- Browser viewport: 1440×1024 via `?qa=1`.

## Comparison evidence

- Normalized reference: `qa/reference-1440x1024.png`
- First implementation capture: `qa/implementation-pass1.png`
- Final implementation capture: `qa/implementation-final.png`
- Final same-input comparison: `qa/comparison-final.png`

## Review log

### Pass 1

- P2: comparison header and checkout content were too compressed vertically.
- P2: center/detail widths, right padding, findings height, and detail footer did not match the target frame.
- P2: the evidence crop and note area caused the detail content to clip above the footer.
- P2: segmented controls, source buttons, selected states, and metric summary needed stronger blue semantic treatment.
- P3: navigation density, sync handle size, control radii, and panel elevation were too close to the grayscale wireframe.

### Fixes applied

- Matched the 60px header, 224px navigation, 76px toolbar, 14px column gap, 305px inspector, 488px comparison area, and 370px findings area.
- Expanded comparison headers to 52px and the sync handle to 44px; recalibrated checkout spacing without removing the intentional evidence differences.
- Added a light blue-gray shell, cool-gray borders, restrained elevation, cobalt active/primary states, amber-only Beta/warning semantics, and a pale-blue metric summary.
- Added distinct Figma/image source buttons, clearer selected navigation/table states, branded markers, badges, review controls, and export affordance.
- Reduced evidence and note heights so all inspector content and the persistent export footer remain visible.
- Added visible blue focus styling, upload focus-within styling, and reduced-motion handling.

## Final assessment

- P0: none.
- P1: none.
- P2: none.
- P3: only expected rendering variation from system font metrics and anti-aliasing. The generated reference also contains slight local geometry inconsistencies; the implementation keeps equal split panes and aligned panel bottoms rather than reproducing those artifacts.
- Core target anatomy, density, hierarchy, color semantics, radii, panel elevation, and default-state content are visually aligned.

## Browser annotation follow-up

- The user's browser annotations supersede the generated reference inside both comparison panes.
- Replaced the checkout mockups with full-pane upload empty states, distinct design/implementation copy, and a direct path to the existing local image-selection dialog.
- Renamed the primary action from “模拟分析” to “开始走查” and aligned the running, overlay, completion, and stale-input copy.
- Verification capture: `qa/upload-empty-state.png` at 1440×1024.
- The comparison modes, upload boundary messaging, fixed findings workflow, and persistent inspector/footer remain available.

## Result-state follow-up

- Replaced the eager demo results with an explicit `idle → ready → running → completed` display model.
- `idle`, `ready`, and `running` now show coordinated empty states in both the findings panel and detail inspector; export remains disabled.
- A completed demo run injects the three fixed findings, selects the first visible issue, enables export, and changes the primary action to “重新走查”.
- Applying images clears and invalidates previous results. A run token prevents an earlier in-flight completion from restoring stale findings after inputs change.
- Status filters now control both the list and detail inspector. A zero-result filter shows an empty detail state and disables export.
- Verification captures: `qa/initial-empty-results.png` and `qa/completed-results-state.png` at 1440×1024.
- Verified initial, ready, running, completed, zero-filter, and in-flight invalidation states with no browser console errors.

final result: passed
