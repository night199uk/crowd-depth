import { expect, test, vi } from "vitest";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { app, config } from "./helper.js";
import { Config } from "../src/config.js";
import { chartMeta, startChart } from "../src/chart.js";
import { createDB } from "../src/storage.js";
import { createSqliteSource } from "../src/sources/sqlite.js";
import { correctForSensorPosition } from "../src/streams/index.js";
import {
  BASE_ZOOM,
  addPendingBackfill,
  backfillTiles,
  createTileWriter,
  getPendingBackfill,
  registerBathymetryRoutes,
  correctToTransducer,
  createTileStore,
  decodeDepth,
  getThrough,
  lngLatToCell,
} from "../src/tiles/index.js";
import { buildDepthField } from "../web/shared/bathymetry.js";

/** GNSS antenna 4 m aft of the transducer and 1 m to port of it. */
const offsetConfig: Config = {
  ...config,
  path: "belowTransducer",
  sounder: { x: 0, y: 2, z: 0.5 },
  gnss: { x: -1, y: 6, z: 2 },
};

const at = (s: string) => Temporal.Instant.from(s);

test("serves the depth offset and transducer offset the plugin applies", () => {
  expect(chartMeta(offsetConfig)).toEqual({
    depthPath: "environment.depth.belowTransducer",
    depthOffset: 0.5,
    transducer: { forward: 4, starboard: 1 },
  });
  expect(chartMeta(config).transducer).toBeNull();
});

test("the client places a live sounding where the plugin records it", () => {
  // The browser shifts live soundings with the served offset; the plugin uses
  // geolib. Both must land on the same spot, or live soundings would sit apart
  // from the tiles they extend.
  const { transducer } = chartMeta(offsetConfig) as {
    transducer: { forward: number; starboard: number };
  };
  const correct = correctForSensorPosition(offsetConfig);
  for (const heading of [0, 0.7, Math.PI / 2, 2.5, Math.PI, 4.4, 6]) {
    const server = correct({
      latitude: 47.6,
      longitude: -122.3,
      depth: 5,
      timestamp: at("2026-10-16T10:00:00Z"),
      heading,
    })!;
    const client = correctToTransducer(
      { lon: -122.3, lat: 47.6 },
      heading,
      transducer,
    )!;
    expect(client.lat).toBeCloseTo(server.latitude, 6);
    expect(client.lon).toBeCloseTo(server.longitude, 6);
  }
});

test("backfills the tiles from the plugin's source with its correction", async () => {
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  const soundings = [
    {
      latitude: 47.6,
      longitude: -122.3,
      depth: 4.2,
      timestamp: at("2026-10-16T09:00:00Z"),
      heading: 0,
    },
    // No heading and an offset: the plugin drops it, so the tiles must too.
    {
      latitude: 47.7,
      longitude: -122.4,
      depth: 1,
      timestamp: at("2026-10-16T09:00:10Z"),
    },
  ];
  await pipeline(Readable.from(soundings), source.createWriter!());

  const store = createTileStore(db);
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"));
  await backfillTiles({
    app,
    config: offsetConfig,
    source,
    store,
    signal: new AbortController().signal,
  });

  const corrected = correctForSensorPosition(offsetConfig)(soundings[0])!;
  const { x, y, cx, cy } = lngLatToCell(
    corrected.longitude,
    corrected.latitude,
    BASE_ZOOM,
  );
  const cells = store.read(BASE_ZOOM, x, y)!;
  expect(decodeDepth(cells.get(cy * 256 + cx)!.depth)).toBe(4.2);

  const dropped = lngLatToCell(-122.4, 47.7, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, dropped.x, dropped.y)).toBeUndefined();
  // Coarser levels are rebuilt when a bulk backfill ends.
  const parent = lngLatToCell(corrected.longitude, corrected.latitude, 10);
  expect(store.read(10, parent.x, parent.y)?.size).toBe(1);
  // Done: nothing is left to backfill, and the live marker is the live
  // writer's alone.
  expect(getPendingBackfill(store)).toBeUndefined();
  expect(getThrough(store)).toBeUndefined();
});

test("backfill starts where the tiles left off", async () => {
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T08:00:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createTileStore(db);
  store.setMeta("through", "2026-10-16T09:00:00Z");
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"));

  await backfillTiles({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });

  const { x, y } = lngLatToCell(0, 0, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, x, y)).toBeUndefined();
});

test("the drawn surface is never deeper than a sounding in range", () => {
  // Every cell a sounding reaches must be at or above that sounding. A plain
  // inverse-distance average (shallowBias 0) fails this next to a shoal.
  let seed = 42;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const coverage = 12;
  const mercX = (lon: number) => (lon * Math.PI * 6378137) / 180;
  const mercY = (lat: number) =>
    6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  for (let run = 0; run < 20; run++) {
    const samples = Array.from({ length: 40 }, () => ({
      lon: random() * 0.001,
      lat: random() * 0.001,
      depth: 1 + random() * 20,
    }));
    const field = buildDepthField(samples, [0, 0, 112, 112], {
      cellMetres: 4,
      coverageMetres: coverage,
    })!;
    const [minX, minY, maxX] = field.extent;
    const cell = (maxX - minX) / field.width;
    for (const sample of samples) {
      const sx = mercX(sample.lon);
      const sy = mercY(sample.lat);
      for (let gy = 0; gy < field.height; gy++) {
        for (let gx = 0; gx < field.width; gx++) {
          const dx = minX + (gx + 0.5) * cell - sx;
          const dy = minY + (gy + 0.5) * cell - sy;
          if (dx * dx + dy * dy > coverage * coverage) continue;
          const depth = field.depth[gy * field.width + gx];
          if (Number.isNaN(depth)) continue;
          expect(depth).toBeLessThanOrEqual(sample.depth + 1e-4);
        }
      }
    }
  }
});

test("the tile tables migrate onto an existing database", () => {
  const dir = mkdtempSync(join(tmpdir(), "crowd-depth-"));
  try {
    const file = join(dir, "bathymetry.sqlite");
    // A database at the schema before the tile tables, with a sounding in it.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE bathymetry(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        longitude REAL NOT NULL, latitude REAL NOT NULL, depth REAL NOT NULL,
        timestamp INTEGER NOT NULL, heading REAL
      );
      CREATE TABLE reports(
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "fromTimestamp" INTEGER NOT NULL, "toTimestamp" INTEGER NOT NULL
      );
      INSERT INTO bathymetry(longitude, latitude, depth, timestamp)
        VALUES (1, 2, 3, 4);
      PRAGMA user_version = 2;
    `);
    old.close();

    const db = createDB(file);
    const { count } = db
      .prepare("SELECT count(*) AS count FROM bathymetry")
      .get() as { count: number };
    expect(count).toBe(1);
    const store = createTileStore(db);
    store.setMeta("through", "2026-10-16T09:00:00Z");
    expect(store.getMeta("through")).toBe("2026-10-16T09:00:00Z");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the backfill still runs after the live writer has moved the marker on", async () => {
  // The plugin records the gap before the live writer starts; the live writer
  // then advances the marker while the source is still being found.
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T08:00:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createTileStore(db);
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"));

  const live = createTileWriter(store, { flushIntervalMs: 100000 });
  live.write(
    {
      latitude: 1,
      longitude: 1,
      depth: 9,
      timestamp: at("2026-10-16T12:05:00Z"),
    },
    () => {},
  );
  await new Promise<void>((resolve) => live.end(() => resolve()));
  expect(getThrough(store)?.toString()).toBe("2026-10-16T12:05:00Z");

  await backfillTiles({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });
  const { x, y } = lngLatToCell(0, 0, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, x, y)?.size).toBe(1);
});

test("an interrupted backfill is widened, not lost, on the next start", () => {
  const store = createTileStore(createDB(":memory:"));
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"));
  const first = getPendingBackfill(store)!;
  // The live writer ran for a while before the plugin restarted.
  store.setMeta("through", "2026-10-16T13:00:00Z");
  addPendingBackfill(store, at("2026-10-16T14:00:00Z"));
  const second = getPendingBackfill(store)!;
  expect(second.from.toString()).toBe(first.from.toString());
  expect(second.to.toString()).toBe("2026-10-16T14:00:00Z");
});

test("a sounding from a clock set in the future can't move the marker past now", async () => {
  const store = createTileStore(createDB(":memory:"));
  const writer = createTileWriter(store, { flushIntervalMs: 100000 });
  writer.write(
    {
      latitude: 0,
      longitude: 0,
      depth: 3,
      timestamp: at("2099-01-01T00:00:00Z"),
    },
    () => {},
  );
  await new Promise<void>((resolve) => writer.end(() => resolve()));
  const through = getThrough(store)!;
  expect(
    Temporal.Instant.compare(through, Temporal.Now.instant()),
  ).toBeLessThanOrEqual(0);
});

test("a failed flush ends the writer instead of throwing from its timer", () => {
  vi.useFakeTimers();
  try {
    const store = createTileStore(createDB(":memory:"));
    store.transaction = () => {
      throw new Error("disk full");
    };
    const writer = createTileWriter(store, { flushIntervalMs: 100 });
    const errors: Error[] = [];
    writer.on("error", (err) => errors.push(err));
    writer.write(
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T08:00:00Z"),
      },
      () => {},
    );
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(writer.destroyed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

/** Enough of the server for startChart: subscriptions, routes, the resource
 * registry, and the Express static mount. */
function serverApp() {
  const routes = new Map<string, (req: unknown, res: unknown) => void>();
  const registerResourceProvider = vi.fn();
  return {
    routes,
    registerResourceProvider,
    app: {
      ...app,
      subscriptionmanager: { subscribe: () => {} },
      getSelfPath: () => undefined,
      get: (path: string, handler: (req: unknown, res: unknown) => void) =>
        routes.set(path, handler),
      use: () => {},
      registerResourceProvider,
    } as unknown as typeof app,
  };
}

test("rebuilds the tiles when the offsets change, and re-offers the layer each start", () => {
  const db = createDB(":memory:");
  const { app: server, registerResourceProvider } = serverApp();
  const first = new AbortController();
  startChart({ app: server, config, db, signal: first.signal });
  const store = createTileStore(db);
  store.write(BASE_ZOOM, 1, 1, new Map([[0, { depth: 300, count: 1 }]]));
  first.abort();

  // Same configuration: the tiles stay.
  const second = new AbortController();
  startChart({ app: server, config, db, signal: second.signal });
  expect(store.read(BASE_ZOOM, 1, 1)?.size).toBe(1);
  second.abort();

  // New offsets: the old tiles would sit beside the new ones, so they go.
  const third = new AbortController();
  startChart({ app: server, config: offsetConfig, db, signal: third.signal });
  expect(store.read(BASE_ZOOM, 1, 1)).toBeUndefined();
  third.abort();

  // The server drops a plugin's providers on stop, so each start registers.
  expect(registerResourceProvider).toHaveBeenCalledTimes(3);
});

test("the tile routes need a principal when security is on", () => {
  const { app: server, routes } = serverApp();
  const secured = Object.assign(server, {
    securityStrategy: { isDummy: () => false },
  });
  registerBathymetryRoutes(
    secured,
    () => undefined,
    () => ({}),
  );
  const meta = [...routes.entries()].find(([path]) =>
    path.endsWith("/meta"),
  )![1];

  const respond = () => {
    const res = {
      code: 200,
      status(code: number) {
        res.code = code;
        return res;
      },
      json: () => res,
    };
    return res;
  };
  const anonymous = respond();
  meta({}, anonymous);
  expect(anonymous.code).toBe(401);

  const readonly = respond();
  meta(
    { skPrincipal: { identifier: "AUTO", permissions: "readonly" } },
    readonly,
  );
  expect(readonly.code).toBe(200);
});

test("after a depth reference change, the SQLite log only backfills newer soundings", async () => {
  // The log stores depths with the offset of their day, so older rows would
  // come back with the old offset.
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T08:00:00Z"),
        heading: 0,
      },
      {
        latitude: 1,
        longitude: 1,
        depth: 4,
        timestamp: at("2026-10-16T10:30:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createTileStore(db);
  addPendingBackfill(store, at("2026-10-16T12:00:00Z"));
  store.setMeta("depth_since", "2026-10-16T10:00:00Z");

  await backfillTiles({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });

  const before = lngLatToCell(0, 0, BASE_ZOOM);
  const after = lngLatToCell(1, 1, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, before.x, before.y)).toBeUndefined();
  expect(store.read(BASE_ZOOM, after.x, after.y)?.size).toBe(1);
});

test("a first start backfills the SQLite log even though no depth reference was recorded", () => {
  const db = createDB(":memory:");
  const { app: server } = serverApp();
  const signal = new AbortController();
  startChart({ app: server, config, db, signal: signal.signal });
  const store = createTileStore(db);
  expect(store.getMeta("depth_since") ?? "").toBe("");
  expect(getPendingBackfill(store)).toBeDefined();
  signal.abort();
});

test("the backfill doesn't merge soundings past its span again", async () => {
  // Sources round windows out to whole hours; the live writer already has the
  // soundings after the span, so merging them again would double their count.
  const db = createDB(":memory:");
  const source = createSqliteSource(app, db);
  await pipeline(
    Readable.from([
      {
        latitude: 0,
        longitude: 0,
        depth: 3,
        timestamp: at("2026-10-16T11:50:00Z"),
        heading: 0,
      },
    ]),
    source.createWriter!(),
  );
  const store = createTileStore(db);
  store.setMeta("through", "2026-10-16T11:00:00Z");
  addPendingBackfill(store, at("2026-10-16T11:30:00Z"));

  await backfillTiles({
    app,
    config,
    source,
    store,
    signal: new AbortController().signal,
  });

  const { x, y } = lngLatToCell(0, 0, BASE_ZOOM);
  expect(store.read(BASE_ZOOM, x, y)).toBeUndefined();
});

test("a failing backfill gives up instead of retrying on every start", async () => {
  const db = createDB(":memory:");
  const { app: server } = serverApp();
  const signal = new AbortController();
  const chart = startChart({ app: server, config, db, signal: signal.signal });
  const store = createTileStore(db);
  expect(getPendingBackfill(store)).toBeDefined();

  await chart.backfill({
    createReader: () => undefined,
    getAvailableTimeframes: () => Promise.reject(new Error("history down")),
  });
  expect(getPendingBackfill(store)).toBeUndefined();
  signal.abort();
});
