import { pipeline } from "stream/promises";
import { Temporal } from "@js-temporal/polyfill";
import { transform } from "stream-transform";
import { ServerAPI } from "@signalk/server-api";
import { Config } from "../config.js";
import { BathymetrySource, Timeframe } from "../types.js";
import { correctForSensorPosition } from "../streams/index.js";
import { TileStore } from "./core/index.js";
import { createTileWriter, getThrough } from "./writer.js";

/** How far back a store with no tiles yet is filled from the plugin's source. */
export const BACKFILL_PERIOD = Temporal.Duration.from({ hours: 30 * 24 });

/** Meta key for the span still waiting to be backfilled, as `from/to`. */
const PENDING_KEY = "backfill";

/** Meta key for when the depth reference last changed. The plugin's SQLite log
 * stores depths with the offset of their day, so it can't rebuild depths from
 * before this; the History API applies the current offset as it reads. */
export const DEPTH_SINCE_KEY = "depth_since";

/** Size of each read from the source. */
const WINDOW = Temporal.Duration.from({ hours: 1 });

export function getPendingBackfill(store: TileStore): Timeframe | undefined {
  const value = store.getMeta(PENDING_KEY);
  if (!value) return undefined;
  const [from, to] = value.split("/").map((v) => Temporal.Instant.from(v));
  return new Timeframe(from, to);
}

/**
 * Record the span the live writer didn't see, before it starts writing: since
 * it last recorded, or {@link BACKFILL_PERIOD} for a new store, up to `until`.
 * A span left from a backfill that didn't finish is widened, not replaced, so
 * an interrupted backfill is run again in full, ancestors included.
 */
export function addPendingBackfill(store: TileStore, until: Temporal.Instant) {
  let from = getThrough(store) ?? until.subtract(BACKFILL_PERIOD);
  let to = until;
  const pending = getPendingBackfill(store);
  if (pending) {
    if (Temporal.Instant.compare(pending.from, from) < 0) from = pending.from;
    if (Temporal.Instant.compare(pending.to, to) > 0) to = pending.to;
  }
  if (Temporal.Instant.compare(from, to) >= 0) return;
  store.setMeta(PENDING_KEY, `${from}/${to}`);
}

/** Give up on the pending span, after a failure or when the tiles are cleared. */
export function clearPendingBackfill(store: TileStore) {
  store.setMeta(PENDING_KEY, "");
}

/**
 * Fill the tiles for the pending span from the plugin's own source (the
 * History API or its SQLite log). Soundings go through the same position
 * correction as what the plugin submits, so the chart shows what is shared.
 * The span is cleared only once the tiles and their ancestors are written.
 */
export async function backfillTiles({
  app,
  config,
  source,
  store,
  signal,
}: {
  app: ServerAPI;
  config: Config;
  source: BathymetrySource;
  store: TileStore;
  signal: AbortSignal;
}): Promise<void> {
  let pending = getPendingBackfill(store);
  if (!pending) return;
  // The SQLite log is the source that can write; its depths from before a
  // depth reference change were recorded with the old offset.
  const depthSince = store.getMeta(DEPTH_SINCE_KEY);
  if (source.createWriter && depthSince) {
    const since = Temporal.Instant.from(depthSince);
    if (Temporal.Instant.compare(since, pending.to) >= 0) {
      clearPendingBackfill(store);
      return;
    }
    if (Temporal.Instant.compare(since, pending.from) > 0) {
      pending = new Timeframe(since, pending.to);
    }
  }

  // Sources round windows out to whole hours; soundings past the span were
  // already written live.
  const windows = (await source.getAvailableTimeframes(pending, WINDOW)).map(
    (window) => window.clamp(pending),
  );
  if (windows.length > 0) {
    app.debug(`Backfilling chart tiles from ${windows.length} windows`);
    await pipeline(
      async function* () {
        for (const window of windows) {
          if (signal.aborted) return;
          const reader = await source.createReader(window);
          if (reader) yield* reader;
        }
      },
      transform(correctForSensorPosition(config)),
      createTileWriter(store, { bulk: true }),
      { signal },
    );
  }
  if (!signal.aborted) clearPendingBackfill(store);
}
