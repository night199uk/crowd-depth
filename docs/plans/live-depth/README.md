# Live depth on the chart

The Crowd Depth plugin collects a vessel's soundings and shares them, but shows the vessel nothing in return. This plan adds a chart layer that draws the vessel's own soundings on Freeboard-SK as they are recorded: a shaded depth surface with isobaths and shoal labels, filling in under the bow. It gives contributors something to see from the data they share, which the [global grid plan](../global-grid/README.md#plugin-as-a-consumer) names as a reason to keep sharing.

The rendering comes from [signalk-livedepth-plugin](https://github.com/night199uk/signalk-livedepth-plugin) (MIT, version 0.3.1), which already does this well as a separate plugin. Its collection layer is derived from Crowd Depth's, so most of what it adds is the tile store and the chart layer, and those are what this plan brings in.

> [!WARNING]
> The layer shows raw soundings from the vessel's own sounder: no tide correction, no QC beyond dropping impossible values, and the offsets as configured. It is **not for navigation**, and the layer says so.

## What LiveDepth provides

| Part               | Files in LiveDepth                                               | What it does                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tile core          | `src/tiles/core/` (grid, accumulator, store, tile source)        | A sparse Web Mercator tile pyramid. Each cell keeps the shallowest sounding and a count, and each coarser level keeps the shallowest of its children, so zooming out never hides a shoal.           |
| Tile store and API | `src/tiles/store.ts`, `writer.ts`, `seed.ts`, `api.ts`           | Tiles in SQLite (`node:sqlite`), a batched live writer, a one-time rebuild from the History API, and a read-only route that serves tiles to the chart.                                              |
| Plotter extension  | `src/plotterext/manifest.ts`, `provider.ts`                      | Offers an `image` overlay, a background runtime and a settings panel to a host that implements the Plotter Extensions API, and serves the pages from a non-admin route.                             |
| Background runtime | `src/web/renderer.ts`                                            | A headless iframe that fetches tiles for the view, folds in live soundings from the Signal K stream every 300 ms, and answers the host's `overlay.request` with frames.                             |
| Render worker      | `src/web/render-worker.ts`, `shared/bathymetry.ts`, `shaders.ts` | Builds a depth field from the soundings and renders it off the main thread: WebGL2 shading and isobaths on an `OffscreenCanvas`, then shoal and cluster labels in 2D, returned as an `ImageBitmap`. |
| Settings panel     | `src/web/config.ts`, `shared/settings.ts`                        | Shade limit, isobath interval, grid cell, safety depth and the other layer settings, shared with the runtime over the bus.                                                                          |
| Build              | `scripts/build-web.mjs`                                          | Bundles the runtime, worker and panel with esbuild into `public/`.                                                                                                                                  |

It needs Freeboard-SK 3.4.0-beta.0 or later, or another host that implements `overlays.image`, and `signalk-plotterext-bus` for the extension messaging.

## What changes when it moves into Crowd Depth

- **The same soundings.** The tile writer reads the plugin's own live stream (`createLiveStream`), with the same depth reference, and backfills from the plugin's source, the History API or its SQLite log, for the time it wasn't running. When a History API provider is present the plugin doesn't run its collector, so the tile writer keeps its own subscription rather than sharing one. Either way the layer shows the soundings the plugin shares.
- **Tiles only.** LiveDepth's browser can also read the History API directly, which would show depths without the plugin's offset. That mode is left out: the layer reads the plugin's tiles and extends them with live soundings corrected the same way the plugin corrects what it records, using the depth offset and antenna-to-transducer offset the tile meta serves.
- **One correction.** Positions are moved to the transducer with Crowd Depth's `correctForSensorPosition` (heading, or course over ground while making way, otherwise dropped), and depths use the plugin's `depthReference`. LiveDepth's own transducer setting is not brought in. Its `correctToTransducer` stays for the browser only, which applies the offsets the plugin serves to its live soundings, drops a sounding with no fresh heading or course as the plugin does, and treats a position, heading or course older than 2 seconds as missing.
- **One database.** The tile tables become a migration in the plugin's existing SQLite database (`runMigrations` in `storage.ts`) rather than a second file, and keep the plugin's WAL and `synchronous = NORMAL` settings, which matter on SD cards.
- **Never deeper than measured.** LiveDepth blends inverse-distance weighting with the shallowest nearby sounding, at `shallowBias` 0.5 by default, so the drawn surface can be deeper than a sounding in range. The ported field uses 1, so it never is. Its coverage radius, which bridges the gaps between consecutive soundings so a track draws as a ribbon, stays, capped so it doesn't widen a track by more than a few metres.
- **A coarser base level.** LiveDepth's base tiles are zoom 20, with cells of about 0.15 m. GNSS positions are good to a few metres at best, so the base drops to zoom 17 (about 1.2 m), which cuts the cells along a track about eightfold, and the base tiles a track touches about as much, without losing anything the positions support.
- **A plain label.** The layer is named "My soundings" in the chart list, and its panel states that the depths are raw and uncorrected.
- **Rebuilt when the offsets change.** The tiles record the configuration they were built with. When the depth reference or sensor offsets change, they are cleared and rebuilt from the source, since old soundings would otherwise sit beside new ones at different positions.
- **The same access as the boat's position.** The server lets anonymous requests through its root path, where the tiles are served, so the tile routes check access themselves: with security on, a request needs a login or the server's read-only access, as the boat's position on the Signal K API does.

## Attribution

LiveDepth is MIT licensed. Ported files carry a header pointing to `THIRD_PARTY_NOTICES.md`, which holds LiveDepth's copyright and permission notice, as the license requires for copies of substantial portions, and the notice for `signalk-plotterext-bus`, which the browser bundles include. The README credits LiveDepth.

LiveDepth's collection code is derived from Crowd Depth's, and its LICENSE doesn't carry Crowd Depth's notice. Raising both with its author at the same time, as a merge of efforts rather than a complaint, is the better outcome: one plugin that collects, shares and shows.

## Package changes

- `packages/signalk-plugin` gains `src/tiles/`, `src/plotterext/` and `web/`, with `public/` built by esbuild and added to the package's `files`, so the pages ship to the AppStore.
- `signalk-plotterext-bus` and `esbuild` become development dependencies. Express stays the server's, required at runtime as LiveDepth does.
- The plugin registers the `plotterExtensions` resource provider when the server supports it and skips the layer quietly when it doesn't, so older servers and other plotters see no change.
- Settings: a "Show my soundings on the chart" switch, on by default, and the layer settings stay in the chart's panel.
- The plugin's keywords add `signalk-category-chart-plotters`.

## Tests

LiveDepth's tests for the grid, accumulator, depth field, manifest and provider come across with the code. New tests cover what changes:

- A sounding written to the tiles has the same position and depth the plugin submits for it, through the same correction and depth reference.
- The depth field is never deeper than the shallowest sounding in range, for random inputs.
- A sounding with no heading and no usable course over ground is dropped from the tiles, as it is from the submission.
- The tile migration runs on an existing database with rows in it.

## Phases

- [x] Port the tile core and store, fed from Crowd Depth's live stream, with the coarser base level and the tile migration.
- [x] Port the plotter extension, runtime, worker and panel, with `shallowBias` 1 and the "My soundings" label.
- [x] Backfill the tiles from the plugin's own database and the History API.
- [ ] Release behind the settings switch, and test on Freeboard-SK 3.4 on a Raspberry Pi for render time and tile writes.

## Open questions

- Which depth the layer shows: the depth the plugin shares, reduced to the waterline where configured, or depth below the keel, which matters more to the skipper. Sharing one depth keeps the layer honest about what is submitted; a keel option could subtract the configured draft.
- Whether the same layer later draws the global crowd overlay beneath the vessel's own soundings, or leaves that to chart providers serving the PMTiles archive.
- How the Plotter Extensions API, at `apiVersion` 1 in a Freeboard beta, settles before release, and how much of `signalk-plotterext-bus` 0.x changes with it.
