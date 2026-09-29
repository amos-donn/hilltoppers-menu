-- Ratings backend for the Hilltoppers menu widget.
--
-- Apply with:
--   npx wrangler d1 execute hilltoppers-menu-ratings --config wrangler.toml --file=schema.sql --remote

-- The catalogue: one row per dish ever seen on the menu, keyed by the
-- normalised dish name so the same dish keeps its ratings across days.
CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- Which days a dish was served, so the catalogue can say when it first
-- appeared and the menu widget can show a dish's history.
CREATE TABLE IF NOT EXISTS dish_days (
  dish_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (dish_id, day)
);

-- Which stations served a dish on which day. A dish can be on both stations,
-- and can move between them, so this is a many-to-many over days.
CREATE TABLE IF NOT EXISTS dish_stations (
  dish_id TEXT NOT NULL,
  station TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (dish_id, station, day)
);

-- One rating per dish per rater. Re-rating replaces the previous value.
CREATE TABLE IF NOT EXISTS dish_ratings (
  dish_id TEXT NOT NULL,
  rater_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (dish_id, rater_id)
);

CREATE INDEX IF NOT EXISTS dish_ratings_by_dish ON dish_ratings (dish_id);

-- A light daily write cap per rater, so a script cannot stuff the ballot.
CREATE TABLE IF NOT EXISTS rater_writes (
  rater_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (rater_id, day)
);
