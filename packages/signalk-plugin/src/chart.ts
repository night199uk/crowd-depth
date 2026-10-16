import { pipeline } from "stream/promises";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { transform } from "stream-transform";
import { ServerAPI } from "@signalk/server-api";
import { Config, depthReference } from "./config.js";
import { BathymetrySource } from "./types.js";
import {
  correctForSensorPosition,
  createLiveStream,
  getOffsets,
} from "./streams/index.js";
import {
  TileStore,
  addPendingBackfill,
  backfillTiles,
  createTileStore,
  createTileWriter,
  registerBathymetryRoutes,
  THROUGH_KEY,
  type BathymetryMeta,
} from "./tiles/index.js";
import { registerPlotterExtension } from "./plotterext/provider.js";

/** Meta key for the configuration the tiles were built with. */
const CONFIG_KEY = "config";

/** What the routes and the plotter extension read; replaced on each start. */
let current: { store: TileStore; meta: BathymetryMeta } | undefined;
let routesRegistered = false;

/**
 * The meta a chart client needs to extend the served tiles with its own live
 * soundings exactly as the plugin records them: the depth path, the offset the
 * plugin adds to each depth, and the GNSS antenna to transducer offset.
 */
export function chartMeta(config: Config): BathymetryMeta {
  const { distance, dx, dy } = getOffsets(config);
  return {
    depthPath: `environment.depth.${config.path}`,
    depthOffset: depthReference(config).offset,
    transducer: distance > 0 ? { forward: dy, starboard: dx } : null,
  };
}

/**
 * Start the "My soundings" chart layer: fold the boat's live soundings into the
 * tile pyramid in the plugin's database, serve the tiles, and offer the layer
 * to chartplotters that support plotter extensions. Returns a backfill to run
 * once the plugin's source is known.
 */
export function startChart({
  app,
  config,
  db,
  signal,
}: {
  app: ServerAPI;
  config: Config;
  db: DatabaseSync;
  signal: AbortSignal;
}) {
  const store = createTileStore(db);
  const startedAt = Temporal.Now.instant();
  const meta = chartMeta(config);

  // Tiles hold soundings corrected with the offsets of their day. When those
  // change, the old ones would sit beside the new, so they are rebuilt.
  const fingerprint = JSON.stringify(meta);
  if (store.getMeta(CONFIG_KEY) !== fingerprint) {
    store.clear();
    store.setMeta(THROUGH_KEY, "");
    store.setMeta(CONFIG_KEY, fingerprint);
  }
  // Before the live writer starts, so its marker doesn't hide the gap.
  addPendingBackfill(store, startedAt);

  current = { store, meta };
  signal.addEventListener("abort", () => {
    current = undefined;
  });

  pipeline(
    createLiveStream(app, config),
    transform(correctForSensorPosition(config)),
    createTileWriter(store),
    { signal },
  ).catch((err: unknown) => {
    if (!signal.aborted) app.error(`Chart tiles stopped: ${err}`);
  });

  registerPlotterExtension(app, () => current !== undefined);
  if (!routesRegistered) {
    registerBathymetryRoutes(
      app,
      () => current?.store,
      () => current?.meta ?? {},
    );
    routesRegistered = true;
  }

  return {
    backfill: (source: BathymetrySource) =>
      backfillTiles({
        app,
        config,
        source,
        store,
        signal,
      }).catch((err: unknown) => {
        if (!signal.aborted) app.error(`Chart backfill failed: ${err}`);
      }),
  };
}
