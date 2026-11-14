-- 2026-11-14: brand, address and postcode, for the app's price lookup and
-- its search. Run once on a database made before then:
--   npx wrangler d1 execute fuel-prices --remote --file=migrate-2026-11-14.sql
-- Dropping stationsDone makes the next cycle read every station again,
-- filling the new columns (about 8,200 row writes, once).
ALTER TABLE stations ADD COLUMN brand TEXT;
ALTER TABLE stations ADD COLUMN address TEXT;
ALTER TABLE stations ADD COLUMN postcode TEXT;
DELETE FROM meta WHERE key = 'stationsDone';
