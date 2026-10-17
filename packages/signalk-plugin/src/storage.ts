import { DatabaseSync } from "node:sqlite";

export function createDB(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL");
  // Skip per-commit fsync so 1Hz depth inserts don't wear out SD cards (#100).
  // WAL + NORMAL is durable against corruption; worst case loses recent rows on power loss.
  db.exec("PRAGMA synchronous = NORMAL");

  runMigrations(db, [
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bathymetry(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          longitude REAL NOT NULL,
          latitude REAL NOT NULL,
          depth REAL NOT NULL,
          timestamp INTEGER NOT NULL,
          heading REAL
        );

        CREATE INDEX IF NOT EXISTS idx_bathymetry_timestamp ON bathymetry(timestamp);
        CREATE INDEX IF NOT EXISTS idx_bathymetry_location ON bathymetry(latitude, longitude);
      `);
    },
    () => {
      db.exec(`
        CREATE TABLE reports (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "fromTimestamp" INTEGER NOT NULL,
          "toTimestamp" INTEGER NOT NULL
        );
      `);
    },
    () => {
      // The water level above chart datum at the sounding, when the server has
      // a tide prediction. Null when unknown, so the depth can still be reduced
      // to a chart datum where the tide is known and left below-surface where it
      // is not.
      db.exec(`ALTER TABLE bathymetry ADD COLUMN tide REAL`);
    },
    () => {
      // The tide value stored per sounding is ambiguous on its own, so record
      // the station it was predicted from. The datum lives once per station in
      // `tide_stations` rather than being repeated across every row — a station's
      // datum is a property of the station, and the reference (not a per-voyage
      // field) tracks a station change mid-track.
      db.exec(`
        ALTER TABLE bathymetry ADD COLUMN tide_station TEXT;

        CREATE TABLE tide_stations(
          station TEXT PRIMARY KEY,
          datum TEXT NOT NULL
        );
      `);
    },
    () => {
      // The chart layer's tile pyramid, derived from the soundings above; see
      // tiles/store.ts.
      db.exec(`
        CREATE TABLE tiles(
          z INTEGER NOT NULL,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          cells BLOB NOT NULL,
          updated INTEGER NOT NULL,
          PRIMARY KEY(z, x, y)
        );

        CREATE TABLE tile_meta(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  ]);

  return db;
}

export type Migration = (db: DatabaseSync) => void;

export function runMigrations(db: DatabaseSync, migrations: Migration[]) {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  migrations.slice(version).forEach((migration, i) => {
    db.exec("BEGIN");
    try {
      migration(db);
      db.exec(`PRAGMA user_version = ${version + i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures to avoid masking the original error.
      }
      throw err;
    }
  });
}
