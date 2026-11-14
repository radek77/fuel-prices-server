CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  -- Address lines and town, without the postcode.
  address TEXT,
  postcode TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stations_lat ON stations (lat);

-- Pence per litre by Fuel Finder fuel type: E10, E5, B7_STANDARD, B7_PREMIUM, B10, HVO.
CREATE TABLE IF NOT EXISTS prices (
  id TEXT NOT NULL,
  fuel TEXT NOT NULL,
  pence REAL NOT NULL,
  updated TEXT,
  PRIMARY KEY (id, fuel)
);

-- Where the cron is: job, batch, lastFirst, token, tokenExpires, stationsDone.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
