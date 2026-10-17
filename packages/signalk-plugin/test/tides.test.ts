import { afterEach, expect, test } from "vitest";
import nock from "nock";
import { createTideStations } from "../src/tides.js";
import { createDB } from "../src/storage.js";
import { app } from "./helper.js";

afterEach(() => {
  nock.cleanAll();
});

const host = "http://tides.test/";
const reply = {
  station: { id: "noaa/9414290", name: "San Francisco" },
  datum: "MLLW",
  heightNow: 1.2,
};

test("resolves the tide station and its datum, recording them once", async () => {
  nock(host).get("/signalk/v2/api/tides/height").reply(200, reply);

  const db = createDB(":memory:");
  const tides = createTideStations(app, db, host);
  expect(tides.current()).toBeUndefined();

  await tides.refresh();

  expect(tides.current()).toEqual({ station: "noaa/9414290", datum: "MLLW" });
  expect(db.prepare("SELECT station, datum FROM tide_stations").all()).toEqual([
    { station: "noaa/9414290", datum: "MLLW" },
  ]);
});

test("keeps a station recorded on an earlier refresh", async () => {
  nock(host).get("/signalk/v2/api/tides/height").reply(200, reply);
  nock(host).get("/signalk/v2/api/tides/height").reply(503);

  const tides = createTideStations(app, createDB(":memory:"), host);

  await tides.refresh();
  await tides.refresh();

  expect(tides.current()).toEqual({ station: "noaa/9414290", datum: "MLLW" });
});

test("leaves the station unset when no tides provider answers", async () => {
  nock(host).get("/signalk/v2/api/tides/height").reply(404);

  const db = createDB(":memory:");
  const tides = createTideStations(app, db, host);

  await tides.refresh();

  expect(tides.current()).toBeUndefined();
  expect(
    db.prepare("SELECT count(*) AS count FROM tide_stations").get(),
  ).toEqual({ count: 0 });
});
