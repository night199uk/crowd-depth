import { Writable } from "stream";
import { Temporal } from "@js-temporal/polyfill";
import { BathymetryData } from "../types.js";
import {
  BASE_ZOOM,
  TileStore,
  createTileAccumulator,
  lngLatToCell,
  rebuildAncestorsOf,
} from "./core/index.js";

/** How long soundings are batched before the base tiles are written. The
 * chart draws its own live soundings meanwhile, so this only bounds how much
 * a restart can lose. */
export const DEFAULT_FLUSH_MS = 10_000;

/** How often the coarser levels are rebuilt from the base tiles written since.
 * Rebuilding them on every flush rewrote a harbour's worth of coarse tiles each
 * second, which wears out an SD card. */
export const DEFAULT_ANCESTORS_MS = 5 * 60_000;

/** Meta key for the time the live writer has recorded soundings through. */
export const THROUGH_KEY = "through";

export function getThrough(store: TileStore): Temporal.Instant | undefined {
  const value = store.getMeta(THROUGH_KEY);
  return value ? Temporal.Instant.from(value) : undefined;
}

/** Advance the marker, never past now, so a sounding from a clock set in the
 * future can't make later backfills skip real time. */
function setThrough(store: TileStore, instant: Temporal.Instant) {
  const now = Temporal.Now.instant();
  const capped = Temporal.Instant.compare(instant, now) > 0 ? now : instant;
  const current = getThrough(store);
  if (!current || Temporal.Instant.compare(capped, current) > 0) {
    store.setMeta(THROUGH_KEY, capped.toString());
  }
}

/**
 * A Writable that folds soundings into the base-level tiles. Soundings arrive
 * already corrected, the way the plugin records them. Writes are batched into
 * one transaction per flush so a 1 Hz+ sounding rate doesn't become a
 * transaction per sample, which would wear out an SD card.
 *
 * Coarser levels are rebuilt from the base tiles touched since the last
 * rebuild: every {@link DEFAULT_ANCESTORS_MS} for the live writer, and once at
 * the end for a `bulk` writer, used by a backfill, whose caller records it as
 * done. The live writer advances the {@link THROUGH_KEY} marker only when it
 * rebuilds, so soundings whose coarser levels were never written, because the
 * process died between rebuilds, are backfilled on the next start.
 *
 * Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
 */
export function createTileWriter(
  store: TileStore,
  {
    baseZoom = BASE_ZOOM,
    flushIntervalMs = DEFAULT_FLUSH_MS,
    ancestorsIntervalMs = DEFAULT_ANCESTORS_MS,
    bulk = false,
  }: {
    baseZoom?: number;
    flushIntervalMs?: number;
    ancestorsIntervalMs?: number;
    bulk?: boolean;
  } = {},
): Writable {
  const accumulator = createTileAccumulator(store, {
    baseZoom,
    ancestors: false,
  });
  const touched = new Map<string, { x: number; y: number }>();
  let latest: Temporal.Instant | undefined;
  let lastAncestors = Date.now();

  const rebuild = () => {
    rebuildAncestorsOf(store, touched.values(), { baseZoom });
    touched.clear();
    lastAncestors = Date.now();
    if (!bulk && latest) setThrough(store, latest);
  };

  const flush = () => {
    accumulator.flush();
    if (!bulk && Date.now() - lastAncestors >= ancestorsIntervalMs) rebuild();
  };

  const writer: Writable = new Writable({
    objectMode: true,
    write(data: BathymetryData, _encoding, callback) {
      try {
        accumulator.add({
          lon: data.longitude,
          lat: data.latitude,
          depth: data.depth,
        });
        const { x, y } = lngLatToCell(data.longitude, data.latitude, baseZoom);
        touched.set(`${x},${y}`, { x, y });
        if (
          data.timestamp &&
          (!latest || Temporal.Instant.compare(data.timestamp, latest) > 0)
        ) {
          latest = data.timestamp;
        }
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    final(callback) {
      clearInterval(timer);
      try {
        flush();
        rebuild();
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    // A pipeline destroys its writer on abort, which does not run `final`, so
    // write what is held here too, or a plugin stop would leave the coarser
    // levels without the last few minutes. Without the clear, the flush timer
    // would outlive the store.
    destroy(error, callback) {
      clearInterval(timer);
      try {
        flush();
        rebuild();
      } catch {
        // The store failed or is gone; the marker wasn't advanced, so the
        // next start backfills what was lost.
      }
      callback(error);
    },
  });

  // A failed write (a full disk, a locked database) ends the stream with the
  // error instead of escaping the timer as an uncaught exception.
  const timer = setInterval(() => {
    try {
      flush();
    } catch (err) {
      writer.destroy(err as Error);
    }
  }, flushIntervalMs);
  timer.unref?.();

  return writer;
}
