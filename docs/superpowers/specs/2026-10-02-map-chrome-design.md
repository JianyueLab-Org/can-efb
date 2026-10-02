# Map chrome: mode bar, toolbar, pinboard

Date: 2026-10-02

## Scope

- A top mode bar: Traffic, ATC, Weather, Pinboard.
- A left toolbar: HIGH/LOW IFR, layers flyout, 3D, locate me.
- A bottom pinboard bar on tablet and desktop: pinned charts as tabs, grouped by airport.
- Zoom and compass move to the top right.
- `MapControls.vue` is replaced by three components.
- The chart pins popover becomes the full chart list, opened from the pinboard bar or, on phones, from the Pinboard button.

Out of scope for this version:

- Route and label styling.
- A night-mode button on the map. The theme stays in the rail.
- A measuring tool.
- Background download of pinned PDFs.
- Server-side storage of pins.

## Constraints that stay

- All controls sit inside the visible map area (`--map-pad-*`).
- Breakpoints live only in CSS. JS reads `--shell-mode` (`parseShellMode`), never `matchMedia`.
- The mapBus stays one-way, panel to map.
- All `/api/db/*` calls go through `dbFetch`.
- Failure is never drawn as empty. Each empty state says why.
- Islands receive only the message keys they use.
- Pure logic lives in `lib/*.ts` with tests.
- Chart pin rules and storage (`lib/chartPins.ts`) are unchanged.

## Layout

Tablet and desktop (`--shell-mode` is `tablet` or `desktop`):

```
┌ rail ┬ panel ┬──────────────────────────────────────────────┐
│      │       │ [Traffic] [ATC] [Weather] [Pinboard]   (i) ⊕ │
│      │       │ ┌──┐                                      ⊖  │
│      │       │ │HI│ HIGH/LOW IFR                          ▲  │
│      │       │ │≡ │ layers flyout                            │
│      │       │ │3D│                                          │
│      │       │ │✈ │ locate me (while connected)              │
│      │       │ └──┘                                          │
│      │       │                       notices: top, centred   │
│      │       │ [▤][ZBTJ][10-9 机场图][SID…][ZSNB][APP…]  50nm │
└──────┴───────┴──────────────────────────────────────────────┘
```

- Top mode bar: labelled toggles in one glass strip, top left of the visible area.
  - Traffic and ATC are the existing live toggles. ATC keeps its station count badge.
  - Weather is the existing toggle. Its legend shows next to the button while weather is on.
  - Pinboard shows and hides the bottom bar.
- Left toolbar: a vertical column of icon buttons below the mode bar.
  - HIGH/LOW IFR: a two-line text button. It switches `chart` between `high` and `low`.
  - Layers: opens a flyout to its right with the static layers: airways, FIRs, navaids, MORA, CTR, APP, restricted. A failed layer's message and retry show in the flyout, next to that layer.
  - 3D: as today.
  - Locate me: only while the member is connected.
- Zoom and compass: MapLibre `NavigationControl` moves from `top-left` to `top-right`, below the attribution button.
- Notices (`useLayerNotice`): top centre, below the mode bar.
- Pinboard bar: bottom of the visible area, full width. The scale bar sits at its right end.

Phone (`--shell-mode` is `phone`):

- The mode bar shows icons only. Each button keeps its text as the accessible name and tooltip.
- The toolbar shows HIGH/LOW, layers and locate me. 3D moves into the layers flyout.
- No pinboard bar. The Pinboard button opens the full chart list.

## Pinboard bar

Contents, left to right:

- List button. Opens the full chart list above the bar.
- Per airport, in plan order (departure, arrival, alternate):
  - An ICAO separator. Not a button.
  - The airport's pinned charts as tabs.
- The bar scrolls horizontally when tabs overflow.

Tab:

- Chart name, at most two lines, truncated.
- A top colour strip in the category colour: STAR green, APP orange, TAXI blue, SID pink, REF violet. Same colours as `CHART_TAG_CLASS`.
- A small dot when the chart was pinned automatically.
- Click opens the chart in the viewer. The open chart's tab is highlighted.
- Clicking another tab swaps the chart in the open viewer.
- Context menu or long press offers "Unpin".

States, shown in the bar instead of tabs:

| State | Display |
|---|---|
| No flight plan | "No flight plan filed" and a link to `/flightplan` |
| Plan could not be read | Error text with a retry button |
| No pinned charts | "No pinned charts" and the list button |
| One airport loading | Its separator shows a spinner |
| One airport failed | Its separator becomes a warning chip with a retry button. Other airports keep their tabs |
| No access / hidden by NAIP setting / no charts | Its separator chip says so briefly. The list has the full text |

Bar visibility: shown only when Pinboard is on and the shell is not `phone`.

## Loading

- First load happens when the bar first becomes visible, or the list is first opened. With Pinboard on (the default) on tablet and desktop, that is when the map mounts. On phones, and while Pinboard is off, nothing loads until the list is opened.
- With Pinboard off on tablet and desktop, the bar and the list are not reachable from the map. Pins stay manageable in airport details. On phones the Pinboard button opens the list.
- Plan changes (`efb:plan-changed`) and `hideNaip` changes refetch.
- Procedure changes (`PROCEDURES_CHANGED_EVENT`) and pin changes (`efb:chart-pins-changed`) re-read local state without refetching.
- Late responses are dropped.

## Chart viewer

- One `ChartViewer.vue` instance, rendered by `MapStage` from the shared open chart.
- `ChartViewer.vue` changes:
  - It reloads when its `chart` prop changes.
  - Its bottom edge is `var(--chart-viewer-bottom, <current value>)`. The pinboard bar sets it to the bar's height while the bar is visible.
- Placement otherwise follows `viewerPlacement`: beside the panel, or full screen on phones.

## Map padding

- `MapStage` adds the pinboard bar's height to the map's bottom padding while the bar is visible. Fit-to-route, centring and the scale bar stay above it.

## Components

| File | Role |
|---|---|
| `components/map/useChartPins.ts` (new) | Shared chart pin state: plan, per-airport `ChartsState`, selection, stored pins, groups, open chart; `load`, `retry`, `toggle`, `open`, `close`. Event listeners. Created once by `MapStage` |
| `components/map/MapModeBar.vue` (new) | Top bar. Props: on states, ATC count, weather on, phone flag, text. Emits `toggle` |
| `components/map/MapToolbar.vue` (new) | Left toolbar and layers flyout. Props: chart, static layer states, busy, failure, 3D, own, phone flag, text. Emits `toggle`, `chart`, `retry`, `view3d`, `locate` |
| `components/map/MapPinboard.vue` (new) | Bottom bar. Reads `useChartPins`. Emits `list` |
| `components/map/ChartPins.vue` | Becomes the full list. Reads `useChartPins` instead of holding state |
| `components/map/MapControls.vue` | Deleted |
| `components/map/MapStage.vue` | Creates `useChartPins`, places the three components and the list, renders the viewer, adds the bar height to padding |
| `components/map/RouteMap.vue` | `NavigationControl` to `top-right` |
| `components/ChartViewer.vue` | Reloads on `chart` change; bottom offset variable |
| `lib/pinboard.ts` (new) | Pure logic for the bar: group building, per-airport chip state |
| `lib/mapPrefs.ts` | Adds `pinboard: boolean`, default `true` |
| `layouts/AppLayout.astro` | Passes the new strings |
| `styles/globals.css` | Mode bar, toolbar, flyout, pinboard bar. `.map-layers`, `.map-layer-*`, `.map-3d-toggle`, `.map-charts-trigger`, `.map-chart-pins` rules updated or removed |

## Accessibility

- Mode bar toggles: buttons with `aria-pressed`.
- Toolbar buttons: accessible names and tooltips.
- Layers flyout: `aria-expanded` and `aria-controls` on the button. Focus moves to the first item on open. Esc closes and returns focus to the button. A click outside closes it.
- Pinboard bar: `role="toolbar"`. Arrow keys move between tabs, Enter opens. The open chart's tab has `aria-current="true"`. Airport status chips use `role="status"`.
- Full chart list: Esc closes it only when focus is inside it. Focus returns to the button that opened it.

## Strings

New keys under `efb.map` in all four languages: mode bar labels (Traffic, ATC, Weather, Pinboard), toolbar names (HIGH/LOW IFR, layers, 3D, locate me), pinboard bar text (list button, no plan, plan failed, no pins, unpin, per-airport chip phrases). Existing `map.layers.*` and `airports.charts.pins.*` keys are reused where the text is the same.

## Testing

- `lib/pinboard.test.ts`:
  - Group building: airport order, pinned charts per airport, category colour.
  - Chip state for each per-airport `ChartsState` and `chartsEmptyReason` result.
- `lib/mapPrefs.test.ts`: `pinboard` defaults to `true`; preferences saved before this change read correctly.
- `lib/chartPins.test.ts`: unchanged.
- Gate: `bun run lint` and `bun run build`.
- Browser checks by hand (session with level 3 or higher):
  - Desktop, tablet and phone layouts.
  - Switching charts from the bar with the viewer open.
  - Bar clear of the scale bar and of fit-to-route.
  - Layers flyout and toolbar by keyboard.
  - Pinboard off: nothing loads.
  - Dark mode.

## Documentation

- AGENTS.md: rewrite the map controls text and the chart pins section. Replace references to `MapControls.vue`. Record the zoom and compass position.
