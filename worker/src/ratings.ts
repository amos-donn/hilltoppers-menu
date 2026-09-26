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
 * Catalogues the dishes served on a day. The widget calls this once per day
 * it renders, so a dish enters the catalogue the first time it is posted to
 * the menu and keeps its ratings when it comes back.
 */
export async function catalogDishes(
  request: Request,
  env: RatingsEnv
): Promise<Response> {
  let body: { date?: unknown; dishes?: unknown };
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
  if (!Array.isArray(body.dishes)) {
    return json({ error: 'dishes must be an array.' }, 400);
  }

  const seen = new Set<string>();
  const dishes: { id: string; name: string }[] = [];
  for (const value of body.dishes) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    const id = dishId(name);
    if (!id || id.length > MAX_DISH_ID_LENGTH) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    dishes.push({ id, name });
    if (dishes.length >= MAX_CATALOG_DISHES) break;
  }

  if (!dishes.length) {
    return json({ catalogued: 0 }, 200);
  }

  const statements = [];
  for (const dish of dishes) {
    statements.push(
      env.RATINGS_DB
        .prepare(
          `INSERT INTO dishes (id, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen`
        )
        .bind(dish.id, dish.name, date, date),
      env.RATINGS_DB
        .prepare('INSERT OR IGNORE INTO dish_days (dish_id, day) VALUES (?, ?)')
        .bind(dish.id, date)
    );
  }
  await env.RATINGS_DB.batch(statements);

  return json({ catalogued: dishes.length }, 200);
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
  }
  if (path === '/api/dishes/catalog' && method === 'POST') {
    return catalogDishes(request, env);
  }
  if (path === '/api/dishes' && method === 'GET') {
    return listDishes(request, env);
  }

  return json({ error: 'Not found.' }, 404);
}
