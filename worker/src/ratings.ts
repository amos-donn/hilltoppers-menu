/**
 * Star ratings for menu dishes.
 *
 * The menu widget catalogues each day's dishes as it loads them, then reads
 * and writes ratings against those dishes. A dish is keyed by its normalised
 * name, so "Scrambled Eggs" keeps one rating history across every day it is
 * served. Ratings are counted live from the rows, so the number shown is
 * always current rather than a nightly roll-up.
 */

import { json, preflight } from './http';

export interface RatingsEnv {
  RATINGS_DB: D1Database;
}

const MAX_DISHES_PER_QUERY = 200;
const MAX_CATALOG_DISHES = 300;
const MAX_DISH_ID_LENGTH = 140;
const MAX_RATER_ID_LENGTH = 64;
const MAX_WRITES_PER_DAY = 300;

/** Must match `dishId()` in index.html so the widget and the API agree. */
export function dishId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function readRaterId(request: Request): string | null {
  const raw = request.headers.get('X-Rater-ID');
  if (!raw) return null;
  const id = raw.trim();
  if (!id || id.length > MAX_RATER_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    return null;
  }
  return id;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function parseDishList(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const dishes: string[] = [];
  for (const part of value.split(',')) {
    const id = dishId(part);
    if (!id || id.length > MAX_DISH_ID_LENGTH) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    dishes.push(id);
    if (dishes.length >= MAX_DISHES_PER_QUERY) break;
  }
  return dishes;
}

/**
 * `dish_stations` was added after the first deploy, and this Worker has no
 * migration step, so the table is created on first use. `wrangler deploy` does
 * not run schema.sql, so without this the per-side cards would silently stay
 * empty on the live database until someone applied the schema by hand. The
 * statement is idempotent, so running it per catalogue call is cheap.
 */
function ensureStationsTable(env: RatingsEnv): Promise<unknown> {
  return env.RATINGS_DB
    .prepare(
      `CREATE TABLE IF NOT EXISTS dish_stations (
         dish_id TEXT NOT NULL,
         station TEXT NOT NULL,
         day TEXT NOT NULL,
         PRIMARY KEY (dish_id, station, day)
       )`
    )
    .run()
    // A failure here should not take the whole request down; the per-side
    // cards will just be empty.
    .catch(() => undefined);
}

interface RatingRow {
  dish_id: string;
  count: number;
  average: number;
}

interface MyRatingRow {
  dish_id: string;
  rating: number;
}

/**
 * The rating for every requested dish: how many people rated it, the average
 * to one decimal, and — when the caller sends a rater id — that rater's own
 * rating so the widget can highlight their stars.
 */
export async function getRatings(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const url = new URL(request.url);
  const dishes = parseDishList(url.searchParams.get('dishes'));
  if (!dishes.length) {
    return json({ ratings: {} }, 200);
  }

  const marks = placeholders(dishes.length);
  const rows = await env.RATINGS_DB
    .prepare(
      `SELECT dish_id, COUNT(*) AS count, AVG(rating) AS average
       FROM dish_ratings WHERE dish_id IN (${marks}) GROUP BY dish_id`
    )
    .bind(...dishes)
    .all<RatingRow>();

  const ratings: Record<string, { count: number; average: number; myRating: number | null }> = {};
  for (const row of rows.results ?? []) {
    ratings[row.dish_id] = {
      count: Number(row.count) || 0,
      average: Math.round((Number(row.average) || 0) * 10) / 10,
      myRating: null
    };
  }

  const raterId = readRaterId(request);
  if (raterId) {
    const mine = await env.RATINGS_DB
      .prepare(
        `SELECT dish_id, rating FROM dish_ratings
         WHERE rater_id = ? AND dish_id IN (${marks})`
      )
      .bind(raterId, ...dishes)
      .all<MyRatingRow>();
    for (const row of mine.results ?? []) {
      const entry = ratings[row.dish_id];
      if (entry) entry.myRating = Number(row.rating) || null;
    }
  }

  return json({ ratings }, 200);
}

/**
 * Records the caller's rating for one dish, replacing their previous rating
 * for it, and returns the dish's updated aggregate so the widget can repaint
 * without a second request.
 */
export async function postRating(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const raterId = readRaterId(request);
  if (!raterId) {
    return json({ error: 'Missing rater id.' }, 400);
  }

  let body: { dish?: unknown; rating?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const id = typeof body.dish === 'string' ? dishId(body.dish) : '';
  const rating = Number(body.rating);
  if (!id || id.length > MAX_DISH_ID_LENGTH) {
    return json({ error: 'A dish name is required.' }, 400);
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return json({ error: 'Rating must be a whole number from 1 to 5.' }, 400);
  }

  const day = todayUtc();
  const usage = await env.RATINGS_DB
    .prepare('SELECT count FROM rater_writes WHERE rater_id = ? AND day = ?')
    .bind(raterId, day)
    .first<{ count: number }>();
  if ((Number(usage?.count) || 0) >= MAX_WRITES_PER_DAY) {
    return json({ error: 'Too many ratings today. Try again tomorrow.' }, 429);
  }

  await env.RATINGS_DB.batch([
    env.RATINGS_DB
      .prepare(
        `INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (dish_id, rater_id)
         DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`
      )
      .bind(id, raterId, rating, Date.now()),
    env.RATINGS_DB
      .prepare(
        `INSERT INTO rater_writes (rater_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT (rater_id, day) DO UPDATE SET count = count + 1`
      )
      .bind(raterId, day)
  ]);

  const aggregate = await env.RATINGS_DB
    .prepare(
      `SELECT COUNT(*) AS count, AVG(rating) AS average
       FROM dish_ratings WHERE dish_id = ?`
    )
    .bind(id)
    .first<{ count: number; average: number }>();

  return json(
    {
      rating: {
        count: Number(aggregate?.count) || 0,
        average: Math.round((Number(aggregate?.average) || 0) * 10) / 10,
        myRating: rating
      }
    },
    200
  );
}

/**
 * Removes the caller's rating for one dish and returns the updated aggregate.
 * Deleting a rating does not refund the daily write cap, so clearing and
 * re-rating in a loop still costs writes like any other change.
 */
export async function deleteRating(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const raterId = readRaterId(request);
  if (!raterId) {
    return json({ error: 'Missing rater id.' }, 400);
  }

  let body: { dish?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const id = typeof body.dish === 'string' ? dishId(body.dish) : '';
  if (!id || id.length > MAX_DISH_ID_LENGTH) {
    return json({ error: 'A dish name is required.' }, 400);
  }

  await env.RATINGS_DB
    .prepare('DELETE FROM dish_ratings WHERE dish_id = ? AND rater_id = ?')
    .bind(id, raterId)
    .run();

  const aggregate = await env.RATINGS_DB
    .prepare(
      `SELECT COUNT(*) AS count, AVG(rating) AS average
       FROM dish_ratings WHERE dish_id = ?`
    )
    .bind(id)
    .first<{ count: number; average: number }>();

  return json(
    {
      rating: {
        count: Number(aggregate?.count) || 0,
        average: Math.round((Number(aggregate?.average) || 0) * 10) / 10,
        myRating: null
      }
    },
    200
  );
}

/**
 * Catalogues the dishes served on a day. The widget calls this once per day
 * it renders, so a dish enters the catalogue the first time it is posted to
 * the menu and keeps its ratings when it comes back.
 *
 * Dishes can be sent either flat (`dishes`) or grouped by the kitchen station
 * that served them (`stations`). The grouped form is what lets the dashboard
 * break ratings down per side; a dish on both stations is recorded under both.
 */
export async function catalogDishes(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  let body: {
    date?: unknown;
    dishes?: unknown;
    stations?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? body.date
    : null;
  if (!date) {
    return json({ error: 'A YYYY-MM-DD date is required.' }, 400);
  }
  if (!Array.isArray(body.dishes) && (body.stations === undefined || typeof body.stations !== 'object')) {
    return json({ error: 'dishes must be an array.' }, 400);
  }

  // id -> the set of stations it was reported under on this day, so a dish on
  // both stations is recorded under both.
  const stationOf = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const add = (value: unknown, station?: string) => {
    if (typeof value !== 'string') return;
    const name = value.trim();
    const id = dishId(name);
    if (!id || id.length > MAX_DISH_ID_LENGTH) return;
    if (!names.has(id)) names.set(id, name);
    if (station) {
      const set = stationOf.get(id) ?? new Set<string>();
      set.add(station);
      stationOf.set(id, set);
    }
  };

  if (Array.isArray(body.dishes)) {
    for (const value of body.dishes) add(value);
  }
  if (body.stations && typeof body.stations === 'object') {
    for (const [station, list] of Object.entries(body.stations as Record<string, unknown>)) {
      if (!Array.isArray(list) || !station.trim()) continue;
      for (const value of list) add(value, station.trim());
    }
  }

  const dishes = [...names.entries()].slice(0, MAX_CATALOG_DISHES);
  if (!dishes.length) {
    return json({ catalogued: 0 }, 200);
  }

  await ensureStationsTable(env);

  const statements = [];
  for (const [id, name] of dishes) {
    const sides = [...(stationOf.get(id) ?? [])];
    statements.push(
      env.RATINGS_DB
        .prepare(
          `INSERT INTO dishes (id, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen`
        )
        .bind(id, name, date, date),
      env.RATINGS_DB
        .prepare('INSERT OR IGNORE INTO dish_days (dish_id, day) VALUES (?, ?)')
        .bind(id, date),
      ...sides.map((station) =>
        env.RATINGS_DB
          .prepare('INSERT OR IGNORE INTO dish_stations (dish_id, station, day) VALUES (?, ?, ?)')
          .bind(id, station, date)
      )
    );
  }
  await env.RATINGS_DB.batch(statements);

  return json({ catalogued: dishes.length }, 200);
}

/**
 * Aggregate counts for the dashboard. Rater ids are random per-browser values,
 * not accounts, so `raters` counts browsers rather than people.
 *
 * `stations` breaks the same numbers down per kitchen station. A dish served
 * on both stations counts toward both, so the station totals can exceed the
 * overall totals — they are a per-side view, not a partition.
 */
export async function ratingStats(
  _request: Request,
  env: RatingsEnv
): Promise<Response> {
  const row = await env.RATINGS_DB
    .prepare(
      `SELECT (SELECT COUNT(*) FROM dish_ratings) AS total_ratings,
              (SELECT COUNT(DISTINCT rater_id) FROM dish_ratings) AS raters,
              (SELECT COUNT(*) FROM dishes) AS catalogue,
              (SELECT COUNT(DISTINCT dish_id) FROM dish_ratings) AS rated_dishes`
    )
    .first<{
      total_ratings: number;
      raters: number;
      catalogue: number;
      rated_dishes: number;
    }>();

  const totalRatings = Number(row?.total_ratings) || 0;
  const raters = Number(row?.raters) || 0;

  // A dish counts toward a station if it was ever catalogued under it. Sorting
  // the days out first is what keeps the counts right: dish_stations holds one
  // row per dish, station and day, so joining ratings to it directly would
  // multiply a long-running dish's ratings by the days it was served. Grouping
  // by the label rather than the raw string also folds the two spellings of
  // "Classic Kitchen" together.
  await ensureStationsTable(env);
  const stationRows = await env.RATINGS_DB
    .prepare(
      `WITH dish_side AS (
         SELECT DISTINCT dish_id,
           CASE
             WHEN station LIKE 'classic%' THEN 'Classic Kitchen'
             WHEN station LIKE 'global%' THEN 'Global Fare'
             ELSE station
           END AS station
         FROM dish_stations
       )
       SELECT dish_side.station AS station,
              COUNT(*) AS ratings,
              COUNT(DISTINCT dr.rater_id) AS raters,
              AVG(dr.rating) AS average
       FROM dish_side
       JOIN dish_ratings dr ON dr.dish_id = dish_side.dish_id
       GROUP BY 1
       ORDER BY 1`
    )
    .all<{
      station: string;
      ratings: number;
      raters: number;
      average: number;
    }>();

  const stations = (stationRows.results ?? []).map((r) => ({
    station: r.station,
    ratings: Number(r.ratings) || 0,
    raters: Number(r.raters) || 0,
    average: Math.round((Number(r.average) || 0) * 10) / 10
  }));

  return json(
    {
      totalRatings,
      raters,
      catalogue: Number(row?.catalogue) || 0,
      ratedDishes: Number(row?.rated_dishes) || 0,
      // Rounded to one decimal so the dashboard does not show 3.666666.
      ratingsPerRater: raters === 0 ? 0 : Math.round((totalRatings / raters) * 10) / 10,
      stations
    },
    200
  );
}

/**
 * Every dish in the catalogue with its rating, newest first. Not used by the
 * widget; it makes the catalogue inspectable from a browser.
 */
export async function listDishes(
  _request: Request,
  env: RatingsEnv
): Promise<Response> {
  const rows = await env.RATINGS_DB
    .prepare(
      `SELECT d.id, d.name, d.first_seen, d.last_seen,
              COUNT(r.rater_id) AS count, AVG(r.rating) AS average
       FROM dishes d
       LEFT JOIN dish_ratings r ON r.dish_id = d.id
       GROUP BY d.id
       ORDER BY d.last_seen DESC, d.name ASC
       LIMIT 500`
    )
    .all<{
      id: string;
      name: string;
      first_seen: string;
      last_seen: string;
      count: number;
      average: number | null;
    }>();

  return json(
    {
      dishes: (rows.results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        count: Number(row.count) || 0,
        average: row.average === null ? null : Math.round(Number(row.average) * 10) / 10
      }))
    },
    200
  );
}

export async function handleRatings(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return preflight();

  if (path === '/api/ratings') {
    if (method === 'GET') return getRatings(request, env);
    if (method === 'POST') return postRating(request, env);
    if (method === 'DELETE') return deleteRating(request, env);
  }
  if (path === '/api/dishes/catalog' && method === 'POST') {
    return catalogDishes(request, env);
  }
  if (path === '/api/dishes' && method === 'GET') {
    return listDishes(request, env);
  }
  if (path === '/api/stats' && method === 'GET') {
    return ratingStats(request, env);
  }

  return json({ error: 'Not found.' }, 404);
}
