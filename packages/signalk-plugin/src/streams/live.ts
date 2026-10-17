import { Context, Delta, Path, ServerAPI } from "@signalk/server-api";
import { PassThrough } from "stream";
import { Config, depthReference } from "../config.js";
import { Temporal } from "@js-temporal/polyfill";
import { BathymetryData } from "../types.js";
import { bowBearing } from "./transforms.js";

/** Maximum age of last position fix for a depth to be saved */
const ttl = 2000;

/** The tide prediction a sounding is recorded against, when the server has one.
 * Read at the sounding's time; absent when no tides provider is configured. */
const TIDE = "environment.tide.heightNow";

export function createLiveStream(app: ServerAPI, config: Config) {
  const path = `environment.depth.${config.path}` as Path;
  const { offset } = depthReference(config);

  app.debug(`Collecting depth data from environment.depth.${path}`);

  const unsubscribes: (() => void)[] = [];

  const stream = new PassThrough({ objectMode: true });
  stream.on("close", () => {
    unsubscribes.forEach((f) => f());
  });

  // Subscribe to data updates
  app.subscriptionmanager.subscribe(
    {
      context: "vessels.self" as Context,
      subscribe: [{ path, policy: "instant" }],
    },
    unsubscribes,
    (error) => app.error(error as string),
    (delta: Delta) => {
      delta.updates.forEach((update) => {
        const timestamp = Temporal.Instant.from(
          update.timestamp ?? Temporal.Now.instant(),
        );
        const position = app.getSelfPath("navigation.position") as
          | {
              value: { longitude: number; latitude: number };
              timestamp: string;
            }
          | undefined;

        if ("values" in update) {
          update.values.forEach(({ value }) => {
            if (!value) return;
            const depth = (value as number) + offset;

            if (!position)
              return app.debug("No position data, ignoring depth data");
            if (isStale(position, timestamp, ttl))
              return app.debug("Stale position data, ignoring depth data");

            const heading = bowBearing({
              heading: freshValue("navigation.headingTrue", timestamp),
              courseOverGround: freshValue(
                "navigation.courseOverGroundTrue",
                timestamp,
              ),
              speedOverGround: freshValue(
                "navigation.speedOverGround",
                timestamp,
              ),
            });

            const data: BathymetryData = {
              longitude: position.value.longitude,
              latitude: position.value.latitude,
              depth,
              timestamp,
              heading,
              tide: freshValue(TIDE, timestamp),
            };

            app.debug(
              "Collected depth: %dm at %d, %d",
              data.depth.toFixed(2),
              data.latitude.toFixed(6),
              data.longitude.toFixed(6),
            );

            stream.push(data);
          });
        }
      });
    },
  );

  return stream;

  function freshValue(path: string, timestamp: Temporal.Instant) {
    const node = app.getSelfPath(path) as
      { value: unknown; timestamp: string } | undefined;
    if (!node || isStale(node, timestamp, ttl)) return undefined;
    return typeof node.value === "number" ? node.value : undefined;
  }
}

function isStale(
  object: { timestamp: string },
  timestamp: Temporal.Instant,
  ttl: number,
) {
  return (
    !object?.timestamp ||
    Temporal.Instant.from(object.timestamp).epochMilliseconds <
      timestamp.subtract({ milliseconds: ttl }).epochMilliseconds
  );
}
