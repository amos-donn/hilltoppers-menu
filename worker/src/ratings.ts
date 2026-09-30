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

/**
 * The day a request is about, as a half-open epoch-millisecond window.
 *
 * Ratings are stamped with `Date.now()`, so "today's ratings" has to be a
 * window over `updated_at`. The dashboard sends its own calendar date and its
 * UTC offset rather than the Worker deriving the date, because the hall is in
 * Vermont: at 8pm Eastern the UTC date has already rolled over, and a rating
 * cast over dinner would land on tomorrow's menu.
 *
 * `getTimezoneOffset()` counts minutes *behind* UTC (240 for EDT), so local
 * midnight in epoch milliseconds is UTC midnight plus that many minutes.
 */
interface Scope {
  date: string;
  startMs: number;
  endMs: number;
}

function resolveScope(request: Request): Scope {
  const url = new URL(request.url);
  const raw = url.searchParams.get('date');
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayUtc();
  const rawOffset = Number(url.searchParams.get('offset'));
  // Anything beyond a day either way is nonsense; clamp rather than reject so a
  // bad widget cannot blank the dashboard.
  const offset = Number.isFinite(rawOffset) ? Math.max(-840, Math.min(840, rawOffset)) : 0;
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  const startMs = midnightUtc + offset * 60_000;
  return { date, startMs, endMs: startMs + 86_400_000 };
}

/**
 * Rater ids are random per-browser tokens that the API trusts without any
 * proof, so they double as a write credential: anyone holding one can post as
 * that browser. The dashboard never needs to tell two raters apart beyond
 * "these were different raters", so only a short prefix leaves the server.
 */
function shortRater(id: string): string {
  return id.slice(0, 8);
}

/**
 * A rating time floored to the start of its minute.
 *
 * History points are bucketed by minute, not by day: on a dish rated a handful
 * of times the interesting shape is how the average moved over an evening, and
 * a day bucket collapses all of it into a single dot. The bucket start is the
 * point's x position, so it sits exactly under the minute that labels it.
 *
 * Offsets are whole minutes, so flooring in UTC lands on the same boundary the
 * caller's clock would.
 */
const MINUTE_MS = 60_000;

function minuteStart(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The station labels, folded together in SQL so the two spellings the source
 * site has used for the same kitchen ("Classic Kitchen" / "Classic") count as
 * one side everywhere the breakdown is computed.
 */
const STATION_LABEL_SQL = `CASE
             WHEN station LIKE 'classic%' THEN 'Classic Kitchen'
             WHEN station LIKE 'global%' THEN 'Global Fare'
             ELSE station
           END`;

/**
 * The permanent sections the menu carries below the two daily stations. They
 * are the same every day, but the widget catalogues them like a station so the
 * dashboard can break ratings down per section. Kept in sync with
 * `STATIC_SECTIONS` in index.html.
 */
const STATIC_SECTIONS = ['Soupside', 'Sauce + Stone', 'Greens', 'Sandwich'];

/** Resolves a caller's station name to the folded label, or null if unknown. */
function stationMatcher(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (!lower) return null;
  if (lower.startsWith('classic')) return 'Classic Kitchen';
  if (lower.startsWith('global')) return 'Global Fare';
  // The static sections are catalogued under their exact section name, so they
  // are matched exactly rather than by prefix ("Sauce + Stone" would otherwise
  // be ambiguous with nothing, but exactness keeps a typo from silently
  // matching a different section).
  const section = STATIC_SECTIONS.find((name) => name.toLowerCase() === lower);
  return section ?? null;
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

/**
 * The meal periods a dish can be served in. The source site publishes three,
 * and the widget catalogues each dish under the one it was listed in, so the
 * dashboard can answer "what did people think of breakfast" rather than only
 * "what did people think".
 */
const PERIODS = ['breakfast', 'lunch', 'dinner'] as const;

function periodMatcher(value: string): (typeof PERIODS)[number] | null {
  const lower = value.trim().toLowerCase();
  return (PERIODS as readonly string[]).includes(lower) ? (lower as (typeof PERIODS)[number]) : null;
}

/** `dish_stations`'s counterpart for meal periods. */
function ensurePeriodsTable(env: RatingsEnv): Promise<unknown> {
  return env.RATINGS_DB
    .prepare(
      `CREATE TABLE IF NOT EXISTS dish_periods (
         dish_id TEXT NOT NULL,
         period TEXT NOT NULL,
         day TEXT NOT NULL,
         PRIMARY KEY (dish_id, period, day)
       )`
    )
    .run()
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
    periods?: unknown;
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
  // A caller may group by station, by meal, by both, or send a flat list; any
  // one of the three shapes is enough, so none is required on its own.
  const hasStations = body.stations !== undefined && typeof body.stations === 'object';
  const hasPeriods = body.periods !== undefined && typeof body.periods === 'object';
  if (!Array.isArray(body.dishes) && !hasStations && !hasPeriods) {
    return json({ error: 'dishes must be an array.' }, 400);
  }

  // id -> the set of stations it was reported under on this day, so a dish on
  // both stations is recorded under both.
  const stationOf = new Map<string, Set<string>>();
  // id -> the set of meal periods it was listed in on this day. A dish served
  // at both lunch and dinner is recorded under both.
  const periodOf = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const add = (value: unknown, station?: string, period?: string) => {
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
    if (period) {
      const set = periodOf.get(id) ?? new Set<string>();
      set.add(period);
      periodOf.set(id, set);
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
  // Only the three known periods are recorded, so a stray value cannot fill the
  // table with rows nothing can ever filter on.
  if (body.periods && typeof body.periods === 'object') {
    for (const [period, list] of Object.entries(body.periods as Record<string, unknown>)) {
      const known = periodMatcher(period);
      if (!Array.isArray(list) || !known) continue;
      for (const value of list) add(value, undefined, known);
    }
  }

  const dishes = [...names.entries()].slice(0, MAX_CATALOG_DISHES);
  if (!dishes.length) {
    return json({ catalogued: 0 }, 200);
  }

  await ensureStationsTable(env);
  await ensurePeriodsTable(env);

  const statements = [];
  for (const [id, name] of dishes) {
    const sides = [...(stationOf.get(id) ?? [])];
    const periods = [...(periodOf.get(id) ?? [])];
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
      ),
      ...periods.map((period) =>
        env.RATINGS_DB
          .prepare('INSERT OR IGNORE INTO dish_periods (dish_id, period, day) VALUES (?, ?, ?)')
          .bind(id, period, date)
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
 * Every figure is returned twice: all-time, and restricted to the ratings cast
 * on the request's day (`today`). `stations` breaks the same numbers down per
 * kitchen station, and each station carries its own `today` block. A dish
 * served on both stations counts toward both, so the station totals can exceed
 * the overall totals — they are a per-side view, not a partition.
 */
export async function ratingStats(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const scope = resolveScope(request);
  const row = await env.RATINGS_DB
    .prepare(
      `SELECT (SELECT COUNT(*) FROM dish_ratings) AS total_ratings,
              (SELECT COUNT(DISTINCT rater_id) FROM dish_ratings) AS raters,
              (SELECT COUNT(*) FROM dishes) AS catalogue,
              (SELECT COUNT(DISTINCT dish_id) FROM dish_ratings) AS rated_dishes,
              (SELECT AVG(rating) FROM dish_ratings) AS average,
              (SELECT COUNT(*) FROM dish_ratings
                 WHERE updated_at >= ?1 AND updated_at < ?2) AS today_ratings,
              (SELECT COUNT(DISTINCT rater_id) FROM dish_ratings
                 WHERE updated_at >= ?1 AND updated_at < ?2) AS today_raters,
              (SELECT COUNT(DISTINCT dish_id) FROM dish_ratings
                 WHERE updated_at >= ?1 AND updated_at < ?2) AS today_dishes,
              (SELECT AVG(rating) FROM dish_ratings
                 WHERE updated_at >= ?1 AND updated_at < ?2) AS today_average`
    )
    .bind(scope.startMs, scope.endMs)
    .first<{
      total_ratings: number;
      raters: number;
      catalogue: number;
      rated_dishes: number;
      average: number | null;
      today_ratings: number;
      today_raters: number;
      today_dishes: number;
      today_average: number | null;
    }>();

  const totalRatings = Number(row?.total_ratings) || 0;
  const raters = Number(row?.raters) || 0;
  const todayRatings = Number(row?.today_ratings) || 0;
  const todayRaters = Number(row?.today_raters) || 0;

  const perRater = (n: number, people: number) =>
    people === 0 ? 0 : Math.round((n / people) * 10) / 10;

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
           ${STATION_LABEL_SQL} AS station
         FROM dish_stations
       )
       SELECT dish_side.station AS station,
              COUNT(*) AS ratings,
              COUNT(DISTINCT dr.rater_id) AS raters,
              COUNT(DISTINCT dr.dish_id) AS dishes,
              AVG(dr.rating) AS average,
              SUM(CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2 THEN 1 ELSE 0 END) AS today_ratings,
              COUNT(DISTINCT CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2
                             THEN dr.rater_id END) AS today_raters,
              COUNT(DISTINCT CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2
                             THEN dr.dish_id END) AS today_dishes,
              AVG(CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2
                       THEN dr.rating END) AS today_average
       FROM dish_side
       JOIN dish_ratings dr ON dr.dish_id = dish_side.dish_id
       GROUP BY 1
       ORDER BY 1`
    )
    .bind(scope.startMs, scope.endMs)
    .all<{
      station: string;
      ratings: number;
      raters: number;
      dishes: number;
      average: number;
      today_ratings: number;
      today_raters: number;
      today_dishes: number;
      today_average: number | null;
    }>();

  const round1 = (value: unknown) => Math.round((Number(value) || 0) * 10) / 10;
  const stations = (stationRows.results ?? []).map((r) => ({
    station: r.station,
    ratings: Number(r.ratings) || 0,
    raters: Number(r.raters) || 0,
    dishes: Number(r.dishes) || 0,
    average: round1(r.average),
    today: {
      ratings: Number(r.today_ratings) || 0,
      raters: Number(r.today_raters) || 0,
      dishes: Number(r.today_dishes) || 0,
      average: r.today_average === null ? 0 : round1(r.today_average)
    }
  }));

  // The same breakdown per meal period, so the dashboard can show "what did
  // people think of breakfast". A dish served at both lunch and dinner counts
  // toward both, exactly as a dish on two stations counts toward both, so these
  // are a per-meal view rather than a partition of the totals.
  await ensurePeriodsTable(env);
  const periodRows = await env.RATINGS_DB
    .prepare(
      `WITH dish_meal AS (
         SELECT DISTINCT dish_id, period FROM dish_periods
       )
       SELECT dish_meal.period AS period,
              COUNT(*) AS ratings,
              COUNT(DISTINCT dr.rater_id) AS raters,
              COUNT(DISTINCT dr.dish_id) AS dishes,
              AVG(dr.rating) AS average,
              SUM(CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2 THEN 1 ELSE 0 END) AS today_ratings,
              COUNT(DISTINCT CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2
                             THEN dr.rater_id END) AS today_raters,
              COUNT(DISTINCT CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2
                             THEN dr.dish_id END) AS today_dishes,
              AVG(CASE WHEN dr.updated_at >= ?1 AND dr.updated_at < ?2
                       THEN dr.rating END) AS today_average
       FROM dish_meal
       JOIN dish_ratings dr ON dr.dish_id = dish_meal.dish_id
       GROUP BY 1
       ORDER BY CASE period WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END`
    )
    .bind(scope.startMs, scope.endMs)
    .all<{
      period: string;
      ratings: number;
      raters: number;
      dishes: number;
      average: number;
      today_ratings: number;
      today_raters: number;
      today_dishes: number;
      today_average: number | null;
    }>();

  const byPeriod = new Map((periodRows.results ?? []).map((r) => [r.period, r]));
  // Every period is listed even when nothing was rated in it, so the dashboard
  // shows a stable Breakfast / Lunch / Dinner row set instead of the cards
  // appearing and disappearing as ratings arrive.
  const periods = PERIODS.map((name) => {
    const r = byPeriod.get(name);
    const ratings = Number(r?.ratings) || 0;
    const ratersIn = Number(r?.raters) || 0;
    const todayIn = Number(r?.today_ratings) || 0;
    const todayRatersIn = Number(r?.today_raters) || 0;
    return {
      period: name,
      ratings,
      raters: ratersIn,
      dishes: Number(r?.dishes) || 0,
      average: round1(r?.average),
      ratingsPerRater: perRater(ratings, ratersIn),
      today: {
        ratings: todayIn,
        raters: todayRatersIn,
        dishes: Number(r?.today_dishes) || 0,
        average: r?.today_average === null || r?.today_average === undefined ? 0 : round1(r.today_average),
        ratingsPerRater: perRater(todayIn, todayRatersIn)
      }
    };
  });

  return json(
    {
      totalRatings,
      raters,
      catalogue: Number(row?.catalogue) || 0,
      ratedDishes: Number(row?.rated_dishes) || 0,
      // Rounded to one decimal so the dashboard does not show 3.666666.
      average: round1(row?.average),
      ratingsPerRater: perRater(totalRatings, raters),
      date: scope.date,
      today: {
        totalRatings: todayRatings,
        raters: todayRaters,
        ratedDishes: Number(row?.today_dishes) || 0,
        average: row?.today_average === null || row?.today_average === undefined
          ? 0
          : round1(row.today_average),
        ratingsPerRater: perRater(todayRatings, todayRaters)
      },
      stations,
      periods
    },
    200
  );
}

/**
 * Per-minute rating history for one dish or one station, for the dashboard's
 * timeline graphs and per-dish drill-down.
 *
 * Each point carries the bucket's own average and the running average up to and
 * including that bucket. The running figure is the one to plot as "the average
 * over time": a bucket's own average swings wildly over two or three ratings,
 * while the running average is what a reader means by the number having moved.
 *
 * Points are bucketed by minute in the caller's timezone (same reason as
 * `resolveScope`), not by day. A day bucket makes a dish rated three times over
 * dinner a single dot, which hides the only shape there is to see; a minute is
 * still coarse enough that a rating spree does not spray the graph with points.
 *
 * A point also carries its `day`, so the dashboard can tell a quiet Tuesday from
 * a quiet month: a gap of minutes and a gap of days look the same on a line
 * chart drawn by index.
 */
export async function ratingHistory(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const url = new URL(request.url);
  const scope = resolveScope(request);
  const dishParam = url.searchParams.get('dish');
  const stationParam = url.searchParams.get('station');
  const periodParam = url.searchParams.get('period');

  if (!dishParam && !stationParam && !periodParam) {
    return json({ error: 'A dish, station or period is required.' }, 400);
  }

  const offsetMinutes = Math.round((scope.startMs - Date.parse(`${scope.date}T00:00:00Z`)) / 60_000);
  // SQLite's modifier is the negation of the browser's getTimezoneOffset.
  const dayModifier = `${-offsetMinutes} minutes`;

  let filter: string;
  let params: unknown[];
  let label: string;
  let station: boolean;

  if (dishParam) {
    const id = dishId(dishParam);
    if (!id || id.length > MAX_DISH_ID_LENGTH) {
      return json({ error: 'A valid dish is required.' }, 400);
    }
    const named = await env.RATINGS_DB
      .prepare('SELECT name FROM dishes WHERE id = ?')
      .bind(id)
      .first<{ name: string }>();
    filter = 'dish_id = ?';
    params = [id];
    // Fall back to the id so an uncatalogued dish still resolves.
    label = named?.name ?? id;
    station = false;
  } else if (stationParam) {
    const match = stationMatcher(String(stationParam));
    if (!match) {
      return json({ error: 'Unknown station.' }, 400);
    }
    await ensureStationsTable(env);
    filter = `dish_id IN (SELECT DISTINCT dish_id FROM dish_stations WHERE ${STATION_LABEL_SQL} = ?)`;
    params = [match];
    label = match;
    station = true;
  } else {
    const match = periodMatcher(String(periodParam));
    if (!match) {
      return json({ error: 'Unknown period.' }, 400);
    }
    await ensurePeriodsTable(env);
    filter = 'dish_id IN (SELECT DISTINCT dish_id FROM dish_periods WHERE period = ?)';
    params = [match];
    label = match;
    // Treated as a side, not a dish: a meal holds many dishes, so the
    // individual-rating list would be meaningless and the dashboard only graphs
    // it.
    station = true;
  }

  // The day modifier is bound first because it sits in the outer SELECT list.
  // Points are per minute, not per day: `date()`/`strftime()` also need the
  // modifier so the timestamps they render are the caller's wall clock.
  const timelineRows = await env.RATINGS_DB
    .prepare(
      `WITH per_minute AS (
         SELECT strftime('%Y-%m-%dT%H:%M', updated_at / 1000, 'unixepoch', ?) AS minute,
                date(updated_at / 1000, 'unixepoch', ?) AS day,
                COUNT(*) AS count,
                AVG(rating) AS average,
                MAX(updated_at) AS last_at
         FROM dish_ratings
         WHERE ${filter}
         GROUP BY 1
       )
       SELECT minute,
              day,
              count,
              average,
              last_at,
              SUM(count) OVER (ORDER BY minute) AS running_count,
              SUM(average * count) OVER (ORDER BY minute)
                / SUM(count) OVER (ORDER BY minute) AS running
       FROM per_minute
       ORDER BY minute`
    )
    .bind(dayModifier, dayModifier, ...params)
    .all<{
      minute: string;
      day: string;
      count: number;
      average: number;
      last_at: number;
      running_count: number;
      running: number;
    }>();

  const timeline = (timelineRows.results ?? []).map((r) => {
    // The bucket start is the x position, so the point sits under the minute
    // that labels it. `rawAt` keeps the real instant: a bucket labelled 12:01
    // can hold a rating cast at 12:01:47.
    const rawAt = Number(r.last_at) || 0;
    return {
      at: minuteStart(rawAt),
      minute: r.minute,
      rawAt,
      day: r.day,
      count: Number(r.count) || 0,
      average: Math.round((Number(r.average) || 0) * 10) / 10,
      running: Math.round((Number(r.running) || 0) * 10) / 10,
      runningCount: Number(r.running_count) || 0
    };
  });

  const summary = timeline.length
    ? { count: timeline[timeline.length - 1].runningCount, average: timeline[timeline.length - 1].running }
    : { count: 0, average: 0 };

  // The individual rows are only meaningful for a single dish; a station can
  // hold thousands and the dashboard only graphs those.
  let ratings: { rater: string; rating: number; updatedAt: number }[] = [];
  if (!station) {
    const ratingRows = await env.RATINGS_DB
      .prepare(
        `SELECT rater_id, rating, updated_at FROM dish_ratings
         WHERE ${filter} ORDER BY updated_at DESC LIMIT 500`
      )
      .bind(...params)
      .all<{ rater_id: string; rating: number; updated_at: number }>();
    ratings = (ratingRows.results ?? []).map((r) => ({
      rater: shortRater(r.rater_id),
      rating: Number(r.rating) || 0,
      updatedAt: Number(r.updated_at) || 0
    }));
  }

  return json(
    {
      scope: dishParam ? 'dish' : periodParam ? 'period' : 'station',
      label,
      date: scope.date,
      count: summary.count,
      average: summary.average,
      timeline,
      ratings
    },
    200
  );
}

/**
 * Every dish in the catalogue with its rating, newest first. Not used by the
 * widget; it makes the catalogue inspectable from a browser.
 *
 * `scope=today` narrows the whole listing to the dishes served on the request's
 * day and to the ratings cast that day. The two are deliberately different
 * filters: the dish list comes from `dish_days` (what the menu served) while the
 * ratings come from the `updated_at` window (what people rated), so a dish that
 * is on today's menu but has not been rated today reports zero rather than
 * disappearing.
 */
export async function listDishes(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const url = new URL(request.url);
  const scope = resolveScope(request);
  const todayOnly = url.searchParams.get('scope') === 'today';
  if (todayOnly) await ensureStationsTable(env);

  // `period=breakfast|lunch|dinner` narrows to the dishes the widget listed
  // under that meal. An unknown period is rejected rather than ignored, so a
  // typo shows up as an error instead of quietly returning everything.
  const periodRaw = url.searchParams.get('period');
  const period = periodRaw ? periodMatcher(periodRaw) : null;
  if (periodRaw && !period) {
    return json({ error: 'Unknown period.' }, 400);
  }
  if (period) await ensurePeriodsTable(env);

  const scopeParams = todayOnly ? [scope.startMs, scope.endMs] : [];

  // The period filter is two different questions depending on scope: with
  // `scope=today` it means "on that meal today", matching the day-scoped dish
  // list; on its own it means "ever listed under that meal". The second is the
  // one the all-time dashboard uses, so a breakfast dish rated weeks ago still
  // shows under Breakfast.
  const clauses: string[] = [];
  const servedParams: unknown[] = [];
  if (todayOnly) {
    clauses.push('d.id IN (SELECT dish_id FROM dish_days WHERE day = ?)');
    clauses.push('d.id IN (SELECT dish_id FROM dish_stations WHERE day = ?)');
    servedParams.push(scope.date, scope.date);
  }
  if (period) {
    if (todayOnly) {
      clauses.push('d.id IN (SELECT dish_id FROM dish_periods WHERE period = ? AND day = ?)');
      servedParams.push(period, scope.date);
    } else {
      clauses.push('d.id IN (SELECT dish_id FROM dish_periods WHERE period = ?)');
      servedParams.push(period);
    }
  }
  const servedClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // MAX_CATALOG_DISHES mirrors how many dishes one catalogue call can add, so a
  // day's browse covers the whole catalogue rather than an arbitrary prefix.
  const rows = await env.RATINGS_DB
    .prepare(
      `SELECT d.id, d.name, d.first_seen, d.last_seen,
              COUNT(r.rater_id) AS count, AVG(r.rating) AS average
       FROM dishes d
       LEFT JOIN dish_ratings r
         ON r.dish_id = d.id${todayOnly ? ' AND r.updated_at >= ? AND r.updated_at < ?' : ''}
       ${servedClause}
       GROUP BY d.id
       ORDER BY d.last_seen DESC, d.name ASC
       LIMIT ${MAX_CATALOG_DISHES}`
    )
    .bind(...scopeParams, ...servedParams)
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
      scope: todayOnly ? 'today' : 'all',
      period,
      date: scope.date,
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

/**
 * How many ratings were cast on each day, for the dashboard's volume graph.
 *
 * One rating is one count, so unlike the average-over-time line this is a
 * simple histogram. Days run in the caller's timezone (same reason as
 * `resolveScope`) and the range is filled with zeroes between the first and the
 * last day that has a rating, because the gaps are the point: a spike on a
 * Friday is only readable next to the quiet weekend either side of it.
 *
 * Optionally narrowed to one meal (`period=`) or one category (`category=`,
 * either a station like "Global Fare" or a static section like "Greens").
 */
export async function dailyCounts(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  const url = new URL(request.url);
  const scope = resolveScope(request);

  const offsetMinutes = Math.round((scope.startMs - Date.parse(`${scope.date}T00:00:00Z`)) / 60_000);
  const dayModifier = `${-offsetMinutes} minutes`;

  // The same meal / category filter the other endpoints take, so the volume
  // graph can answer "ratings per day at dinner" as well as overall.
  const periodRaw = url.searchParams.get('period');
  const period = periodRaw ? periodMatcher(periodRaw) : null;
  if (periodRaw && !period) {
    return json({ error: 'Unknown period.' }, 400);
  }

  const categoryRaw = url.searchParams.get('category');
  let filter = '';
  const params: unknown[] = [];
  if (period) {
    await ensurePeriodsTable(env);
    filter = 'WHERE dish_id IN (SELECT DISTINCT dish_id FROM dish_periods WHERE period = ?)';
    params.push(period);
  } else if (categoryRaw) {
    const match = stationMatcher(categoryRaw);
    if (!match) {
      return json({ error: 'Unknown category.' }, 400);
    }
    await ensureStationsTable(env);
    filter = `WHERE dish_id IN (SELECT DISTINCT dish_id FROM dish_stations WHERE ${STATION_LABEL_SQL} = ?)`;
    params.push(match);
  }

  const rows = await env.RATINGS_DB
    .prepare(
      `SELECT date(updated_at / 1000, 'unixepoch', ?) AS day, COUNT(*) AS count
       FROM dish_ratings
       ${filter}
       GROUP BY 1
       ORDER BY 1`
    )
    .bind(dayModifier, ...params)
    .all<{ day: string; count: number }>();

  const byDay = new Map((rows.results ?? []).map((r) => [r.day, Number(r.count) || 0]));
  const days: { day: string; count: number }[] = [];
  if (byDay.size) {
    // Walk the calendar from the first rated day to the last, filling the quiet
    // days with zero so the histogram has an even time axis. Capped so a
    // database left running for years cannot emit an unbounded payload.
    const keys = [...byDay.keys()].sort();
    const start = Date.parse(`${keys[0]}T00:00:00Z`);
    const end = Date.parse(`${keys[keys.length - 1]}T00:00:00Z`);
    const MAX_DAYS = 366;
    let at = start;
    for (let n = 0; n < MAX_DAYS && at <= end; n++) {
      const day = new Date(at).toISOString().slice(0, 10);
      days.push({ day, count: byDay.get(day) ?? 0 });
      at += 86_400_000;
    }
  }

  return json(
    {
      date: scope.date,
      period,
      category: categoryRaw ? stationMatcher(categoryRaw) : null,
      total: days.reduce((sum, d) => sum + d.count, 0),
      days
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
  if (path === '/api/ratings/history' && method === 'GET') {
    return ratingHistory(request, env);
  }
  if (path === '/api/ratings/daily' && method === 'GET') {
    return dailyCounts(request, env);
  }
  if (path === '/api/stats' && method === 'GET') {
    return ratingStats(request, env);
  }

  return json({ error: 'Not found.' }, 404);
}
