# Chart pins from the flight plan

Date: 2026-10-02

## Scope

- The map gets a Charts button. It opens a popover listing the charts for the member's flight plan.
- Charts for the departure, arrival and alternate airports are matched automatically and pinned.
- Members pin and unpin charts by hand. Manual changes are stored on this device.
- Charts open in the existing `ChartViewer.vue`.

Out of scope for this version:

- Background download of pinned PDFs.
- Server-side storage of pins.
- Any change to can-db or can-api.

## Constraints that stay

- No `/charts` page. Airport details keep their chart tab.
- All `/api/db/*` calls go through `dbFetch`.
- can-db decides access. The EFB shows the result and does not re-check it.
- Failure is never drawn as empty. Each empty state says why.
- The mapBus stays one-way, panel to map. The map opening its own viewer is allowed.
- Islands receive only the message keys they use.
- Pure logic lives in `lib/*.ts` with tests.

## Inputs

- Flight plan: `loadFlightPlan()` (`lib/planStore.ts`). Fields used: `departure`, `arrival`, `alternate`.
- Procedure selection: `readSelection(departure, arrival)` (`lib/procedureSelection.ts`). Fields used: `depRunway`, `sid`, `arrRunway`, `star`, `approach`. Labels come from `procedureLabel`, for example `PIKAS6D`, `I16L`, `R01-Y`.
- Chart index per airport: `GET /api/db/aip/airports/{ICAO}/charts`, parsed by `parseChartIndex`. Categories: `STAR`, `APP`, `TAXI`, `SID`, `REF`.

## Matching rules (`lib/chartPins.ts`)

NAIP chart names in the index look like this (ZSPD, cycle 2610):

| Category | Example names |
|---|---|
| SID | `RNAVRWY34L34R35L35R(PIKAS)`, `RWY16L16R17L17R(PIKASODULO)` |
| STAR | `RNAVRWY16L16R34L34R(DUMET)`, `RWY34L34R35L35R(MATNUDUMETBKANDSASAN)` |
| APP | `ILSDMEyRWY16L`, `RNAVILSDMEzRWY16L`, `RNPRWY35R`, `VORDMERWY17L` |
| TAXI | `机场图`, `停机位置图`, `机场地面活动图` |

Rules:

| Airport | Auto-pinned |
|---|---|
| Departure | TAXI charts named `机场图` or `停机位置图`. With a SID selected: SID charts that match the SID. |
| Arrival | TAXI charts named `机场图` or `停机位置图`. With a STAR selected: STAR charts that match the STAR. With an approach selected: APP charts that match the approach. |
| Alternate | TAXI charts named `机场图`. |

SID and STAR match:

- The fix is the procedure label's leading letters before the first digit. `PIKAS6D` gives `PIKAS`.
- The chart name's bracketed part contains the fix as a substring.
- When a runway is selected, the chart name's runway list contains it. The runway list is the run of runway designators after `RWY`, split as `\d{2}[LRC]?`.
- When no runway is selected, the runway check is skipped.

Approach match:

- The label's first letter gives the type. `I` matches names containing `ILS`. `R` matches names starting with `RNP` or `RNAV` without `ILS`. `D` and `V` match names containing `VOR`. `N` matches names containing `NDB`. `L` matches names containing `LOC`.
- The label's runway, for example `16L` from `I16L`, matches the runway after `RWY` exactly.
- A variant suffix (`-Y`, `-Z`) matches the lowercase variant letter before `RWY`. A label without a variant matches charts with or without one.

Known limitation: fix matching is a substring test on concatenated names. `AND` matches inside `SASAN`. Auto pins carry an "auto" mark and can be unpinned.

## Pin storage

- Key: `efb:chart-pins:{DEP}-{ARR}` in localStorage, next to `efb:procedures:`.
- Value: `{ pinned: number[], unpinned: number[] }`. Entries are chart ids.
- Result: auto matches, plus `pinned`, minus `unpinned`.
- Pinning an auto chart that was unpinned removes it from `unpinned`. Unpinning a manual pin removes it from `pinned`.
- A change dispatches `efb:chart-pins-changed` on `window`. Listeners re-read storage.
- Storage errors (private mode, blocked site data) behave as empty storage.
- Chart ids that are no longer in the index are ignored, not shown.

## Components

- `MapControls.vue`: new Charts button next to Locate, Layers and 3D.
- `ChartPins.vue` (new, mounted by `MapStage.vue`): the popover.
- `MapStage.vue`: new props `aipAccess` and the chart-pin text.
- `AppLayout.astro`: passes `Astro.locals.user?.aipAccess ?? 0` and the text.
- `AirportCharts.vue`: each row gets the same pin button, writing the same storage.
- `ChartViewer.vue`: unchanged.

## Popover

- Groups in order: departure, arrival, alternate. A missing alternate has no group.
- Each group lists pinned charts first. A collapsed "All charts (N)" list follows, sorted by category.
- Each row: category tag, name, page, "auto" mark when matched automatically, pin button.
- Clicking a row opens `ChartViewer.vue`. Placement follows `viewerPlacement`: full screen on phones, beside the popover on wider screens.
- No flight plan: one sentence and a link to `/flightplan`.

## Loading

- First load happens when the popover first opens. Nothing loads with the map.
- While the popover is open, it reloads on `efb:plan-changed`, `PROCEDURES_CHANGED_EVENT` and `hideNaip` changes. `efb:chart-pins-changed` re-merges without refetching.
- The plan comes from `loadFlightPlan()`.
- The three indexes are fetched in parallel with `dbFetch`. PDFs are fetched only when a chart is opened.

## States

Per airport, from `chartsState` and `chartsEmptyReason`:

| State | Display |
|---|---|
| No access (level below 3) | Who can grant access |
| Hidden by the NAIP setting | Points to the setting |
| No charts for the airport | Says so |
| can-db or network failure | Error with a retry button for that airport |

- A failure in one airport does not affect the others.
- A selected procedure with no matching chart: "No chart matched {procedure}; pick one from the list below."

## Testing

- `lib/chartPins.test.ts`:
  - SID and STAR matching with runway lists, concatenated fixes, RNAV and conventional charts.
  - Approach matching for ILS with `y`/`z` variants, RNP, VOR.
  - The `AND`/`SASAN` false hit, asserted as a match.
  - Storage merge: auto plus pinned minus unpinned, re-pin and un-pin transitions, unknown ids dropped, corrupt storage.
- Gate: `bun run lint` and `bun run build`.
- Browser checks by hand (needs a session with level 3 or higher): popover with and without a plan, auto pins after selecting procedures, manual pin from the popover and from airport details, NAIP setting on and off, phone layout.
