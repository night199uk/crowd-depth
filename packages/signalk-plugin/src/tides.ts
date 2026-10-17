import { DatabaseSync } from "node:sqlite";
import { ServerAPI } from "@signalk/server-api";
import fetch from "./fetch.js";

/** The station a tide was predicted from, and the datum its heights are on. */
export type TideStation = { station: string; datum: string };

/** How often to re-check which station the predictions come from. */
export const TIDE_REFRESH_MS = 10 * 60 * 1000;

/**
 * Resolves which tide station the server's predictions come from, and what datum
 * its heights are on, by asking the tides API. The datum belongs to the station,
 * so it is recorded once in `tide_stations`; a sounding then only carries the
 * station reference.
 *
 * The Signal K spec describes `environment.tide.heightNow` as relative to
 * LAT/Chart Datum, but providers differ in practice — a NOAA station predicts
 * on MLLW — so the datum is read and stored rather than assumed.
 */
export function createTideStations(
  app: ServerAPI,
  db: DatabaseSync,
  host: string,
) {
  const upsert = db.prepare(
    `INSERT INTO tide_stations(station, datum) VALUES(:station, :datum)
     ON CONFLICT(station) DO UPDATE SET datum = excluded.datum`,
  );

  let cached: TideStation | undefined;
  let inFlight: Promise<void> | undefined;

  /** The last station resolved, for a synchronous read while recording. */
  function current(): TideStation | undefined {
    return cached;
  }

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const url = new URL("/signalk/v2/api/tides/height", host);
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          station?: { id?: unknown };
          datum?: unknown;
        };
        const station = body?.station?.id;
        const datum = body?.datum;
        if (typeof station !== "string" || typeof datum !== "string") {
          throw new Error("The tides API returned no station and datum");
        }
        upsert.run({ station, datum });
        cached = { station, datum };
      } catch (err) {
        // No tides provider, or none ready yet. Keep the last known station and
        // try again on the next refresh; soundings are still recorded without it.
        app.debug("Could not resolve the tide station: %s", err);
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  return { current, refresh };
}

export type TideStations = ReturnType<typeof createTideStations>;
