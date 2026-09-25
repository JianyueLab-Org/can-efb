# can-efb redesign

Date: 2026-09-25
Branch: `feat/efb-redesign`

## Scope

- New shell: full-bleed map with a floating panel.
- All six pages moved onto the new shell.
- Cleanup: oversized files split, uniform empty/error states, accessibility, hydration, dead code, stale docs.

## Constraints that stay

- No top header. Brand, ⌘K, nav, theme, language and account live in the rail.
- No Secret, no database credential. The browser calls only same-origin `/api/v1/*` (can-api) and `/api/db/*` (can-db). The session cookie is forwarded, never read for authority.
- The map persists across pages via `transition:persist`.
- Rail collapse state lives in `html[data-rail]`, set by `RailScript` before first paint.
- Files copied from can-web / can-radar (`i18n.ts`, icons, the upper part of `globals.css`, `geo.ts`, `atc.ts`, `traffic.ts`) are not edited here.
- Islands receive only the `efb` messages namespace.
- Honest states: no fake data; empty and failed are distinct; can-db 401/403 gets its own message.
- can-ui is not modified.

## Shell

Layers, bottom to top:

1. `MapStage` — MapLibre, fills the viewport, `transition:persist`.
2. `AppRail` — slim, glass, pinned left. Contents unchanged.
3. `FloatingPanel` — glass card right of the rail, 12px inset from top, bottom and left.

`MapStage` replaces `MapSurface.vue`. It is split into:

- layer registry
- traffic layer
- route layer (route lines in avionics magenta)
- map controls

`FloatingPanel`:

- Width is declared per page: `panel="standard"` (~26rem) or `panel="wide"` (~44rem, two-column forms).
- `wide` pages: `/flightplan`, `/settings`. All others: `standard`.
- Width changes animate `width`.
- The map receives the panel width and calls `map.setPadding`, so content centres in the visible area.
- A button collapses the panel to a thin bar.

### Breakpoints

Defined only in `globals.css`.

| Viewport   | Rail                                   | Panel                           |
| ---------- | -------------------------------------- | ------------------------------- |
| ≥1152px    | Shown, collapsible                     | `standard` or `wide`            |
| 768–1151px | Collapsed by default                   | `wide` falls back to `standard` |
| <768px     | Replaced by a bottom tab bar (5 items) | Bottom sheet                    |

Bottom sheet:

- Three snap points: collapsed, half, full.
- Draggable.
- Form pages open at full; map pages open at half.

### Glass material

- One `.glass` class in can-efb's `globals.css`, below the copied section.
- Built from can-ui tokens plus `backdrop-filter: blur() saturate()`.
- Falls back to the solid can-ui surface under `prefers-reduced-transparency` or without `backdrop-filter` support.
- Follows the existing light/dark theme.

## Shared components

In `src/components/ui/`.

`StateCard`:

- `kind`: `empty | error | forbidden | loading`.
- `error` carries a retry action.
- `forbidden` is the can-db 401/403 explanation.
- Replaces the dashed cards in `airports.astro` and `404.astro` and the per-island error markup.

`PanelSection`:

- Heading plus content.
- Replaces the bare `<h2>` blocks in `route.astro`.

`Field` / `FieldGrid`:

- Label, hint, error, `aria-describedby`.
- `FieldGrid` goes two-column in `wide` via container queries.

## Pages

`/` Dashboard — `standard`

- User summary, current flight plan card, departure and arrival METAR.
- Map shows the current flight plan's route.

`/flightplan` — `wide`

- Two-column form.
- The route string draws on the map as it is typed.
- SimBrief import at the top of the form.
- 409 (controller holds the track) shows a lock banner.
- `FlightPlan.vue` splits into form, SimBrief import and status bar.

`/route` — `standard`

- One page, two tabs: Generate and Expand.
- Generate stays gated by `aipAccess`; without it the tab shows `StateCard kind="forbidden"`.

`/airports` — `standard`

- Search list and detail view.
- Selecting an airport flies the map to it.
- Error states move from Astro into the island.

`/settings` — `wide`

- Three groups: account (read-only), preferences, SimBrief.

`404`

- Uses `StateCard`.

## Data flow

- API access is unchanged.
- Panel → map stays on `mapBus` (one-way `CustomEvent`).
- New messages:
  - `panel:layout` — panel width and collapsed state.
  - `map:focus` — fly to a point or bounds.
- The map does not send events to panels.

## Error handling

- Every island request resolves to `data | empty | error | forbidden`, rendered through `StateCard`.
- A failed map layer shows a small notice in a map corner with a retry, instead of disappearing.

## Hydration

- `client:load` only for the rail, the map and the current page's primary island.
- Other islands use `client:idle` or `client:visible`.

## Cleanup

- Delete `src/components/Placeholder.astro`.
- Remove Leaflet / `invalidateSize()` comments.
- AGENTS.md: fix stale paths, drop the `/charts` placeholder line, replace the `clamp(20rem,23vw,26rem)` / three-column rule with the rules in this document.

## Testing

- `bun test` for new pure logic:
  - panel width → map padding
  - request result → state kind
  - bottom-sheet snap points
- Every commit passes `bun run lint && bun run build`.
- Manual check in the browser at ≥1152px, tablet and phone widths, light and dark.

## Delivery

One commit per step on `feat/efb-redesign`:

1. Shell: `MapStage`, `.glass`, `FloatingPanel`, rail, mobile tab bar and sheet.
2. Shared components: `StateCard`, `PanelSection`, `Field`.
3. Dashboard.
4. Flight plan.
5. Route.
6. Airports and 404.
7. Settings.
8. Hydration, dead code, AGENTS.md.

After merge to `main`: push can-efb, then bump the `can-efb` pointer in the monorepo root.
