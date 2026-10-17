import { pipeline } from "stream/promises";
import { createLiveStream, toPrecision } from "./streams/index.js";
import { ServerAPI } from "@signalk/server-api";
import { Config } from "./config.js";
import { TideStations } from "./tides.js";
import { transform } from "stream-transform";
import { Writable } from "stream";

export interface CollectorOptions {
  app: ServerAPI;
  config: Config;
  writer: Writable;
  tideStations?: TideStations;
  signal: AbortSignal;
}

export function createCollector({
  app,
  config,
  writer,
  tideStations,
  signal,
}: CollectorOptions) {
  return pipeline(
    createLiveStream(app, config, tideStations),
    transform(toPrecision()),
    writer,
    { signal },
  );
}
