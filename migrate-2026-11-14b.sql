-- 2026-11-14, later: the station's phone, amenities, opening times, fuels sold,
-- motorway and supermarket flags, and a temporary closure kept apart from
-- a permanent one, for the app's station sheet. Run once:
--   npx wrangler d1 execute fuel-prices --remote --file=migrate-2026-11-14b.sql
-- Dropping stationsDone makes the next cycle read every station again.
ALTER TABLE stations ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stations ADD COLUMN phone TEXT;
ALTER TABLE stations ADD COLUMN amenities TEXT;
ALTER TABLE stations ADD COLUMN opening_times TEXT;
ALTER TABLE stations ADD COLUMN fuel_types TEXT;
ALTER TABLE stations ADD COLUMN motorway INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stations ADD COLUMN supermarket INTEGER NOT NULL DEFAULT 0;
DELETE FROM meta WHERE key = 'stationsDone';
