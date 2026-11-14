CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  -- Address lines and town, without the postcode.
  address TEXT,
  postcode TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  -- Permanently; `temporary` is closed for three days or more.
  closed INTEGER NOT NULL DEFAULT 0,
  temporary INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  -- JSON, as Fuel Finder sends them: a list of names; usual_days and
  -- bank_holidays; the fuels sold, by the prices' names.
  amenities TEXT,
  opening_times TEXT,
  fuel_types TEXT,
  motorway INTEGER NOT NULL DEFAULT 0,
  supermarket INTEGER NOT NULL DEFAULT 0
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
