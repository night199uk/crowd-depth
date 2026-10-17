import { Temporal } from "@js-temporal/polyfill";
import { Readable, Writable } from "stream";

export type MaybePromise<T> = T | Promise<T>;

export class Timeframe {
  constructor(
    public from: Temporal.Instant,
    public to: Temporal.Instant,
  ) {}

  clamp(bounds: Timeframe): Timeframe {
    const clampedFrom =
      Temporal.Instant.compare(this.from, bounds.from) < 0
        ? bounds.from
        : this.from;
    const clampedTo =
      Temporal.Instant.compare(this.to, bounds.to) > 0 ? bounds.to : this.to;
    return new Timeframe(clampedFrom, clampedTo);
  }

  get duration(): Temporal.Duration {
    return this.to.since(this.from);
  }
}

export type BathymetryData = {
  latitude: number;
  longitude: number;
  depth: number;
  timestamp: Temporal.Instant;
  heading?: number;
  /**
   * Water level above chart datum at the sample, in metres, when the server has
   * a tide prediction. Recorded so the depth can be reduced to a chart datum
   * later; the stored depth itself stays below surface.
   */
  tide?: number;
  /**
   * The tide station `tide` was predicted from. The datum belongs to the station,
   * not the sample, so it is held once in the `tide_stations` table rather than
   * repeated on every sounding — and the reference, unlike the datum, follows a
   * station change mid-voyage.
   */
  tideStation?: string;
};

export interface BathymetrySource {
  createWriter?: () => Writable;
  createReader: (options: Timeframe) => MaybePromise<Readable | undefined>;
  getAvailableTimeframes(
    timeframe: Timeframe,
    windowSize: Temporal.Duration,
  ): MaybePromise<Timeframe[]>;
}
