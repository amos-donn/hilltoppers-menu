import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import worker from './index';
import { dishId, type RatingsEnv } from './ratings';

let mf: Miniflare;
let env: RatingsEnv;

const RATER = 'rater-1';

function req(
  path: string,
  method = 'GET',
  body?: unknown,
  raterId: string | null = RATER
): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raterId) headers['X-Rater-ID'] = raterId;
  return new Request(`https://example.org${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

const rate = (dish: string, rating: unknown, raterId: string | null = RATER) =>
  worker.fetch(req('/api/ratings', 'POST', { dish, rating }, raterId), env);

const read = (dishes: string[], raterId: string | null = RATER) =>
  worker.fetch(req(`/api/ratings?dishes=${encodeURIComponent(dishes.join(','))}`, 'GET', undefined, raterId), env);

const bodyOf = async (r: Response) => (await r.json()) as any;

const catalog = (date: string, dishes?: unknown, stations?: unknown) =>
  worker.fetch(req('/api/dishes/catalog', 'POST', { date, dishes, stations }), env);

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['RATINGS_DB']
  });
  env = { RATINGS_DB: await mf.getD1Database('RATINGS_DB') } as unknown as RatingsEnv;
  // Vitest runs from the worker directory.
  const schema = readFileSync('schema.sql', 'utf8');
  for (const statement of schema.split(';').filter((part: string) => part.trim())) {
    await env.RATINGS_DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.RATINGS_DB.batch([
    env.RATINGS_DB.prepare('DELETE FROM dish_ratings'),
    env.RATINGS_DB.prepare('DELETE FROM rater_writes'),
    env.RATINGS_DB.prepare('DELETE FROM dish_days'),
    env.RATINGS_DB.prepare('DELETE FROM dish_stations'),
    env.RATINGS_DB.prepare('DELETE FROM dish_periods'),
    env.RATINGS_DB.prepare('DELETE FROM dishes')
  ]);
});

afterAll(async () => {
  await mf.dispose();
});

describe('dish ids', () => {
  test('normalise the same way the widget does', () => {
    expect(dishId('  Scrambled   Eggs ')).toBe('scrambled eggs');
    expect(dishId('BBQ Chicken Wings')).toBe('bbq chicken wings');
  });
});

describe('reading ratings', () => {
  test('unknown dishes read as empty, and no dishes is an empty map', async () => {
    expect(await (await read(['Nothing Yet'])).json()).toEqual({ ratings: {} });
    expect(await (await worker.fetch(req('/api/ratings'), env)).json()).toEqual({ ratings: {} });
  });

  test('aggregates every rater and reports the caller own rating', async () => {
    await rate('Scrambled Eggs', 5);
    await rate('Scrambled Eggs', 3, 'rater-2');
    await rate('Scrambled Eggs', 4, 'rater-3');

    const mine = (await (await read(['scrambled eggs'])).json()) as any;
    expect(mine.ratings['scrambled eggs']).toEqual({ count: 3, average: 4, myRating: 5 });

    const anonymous = (await (await read(['scrambled eggs'], null)).json()) as any;
    expect(anonymous.ratings['scrambled eggs']).toEqual({ count: 3, average: 4, myRating: null });
  });

  test('rounds the average to one decimal', async () => {
    await rate('Poutine', 5, 'rater-1');
    await rate('Poutine', 4, 'rater-2');
    await rate('Poutine', 4, 'rater-3');
    const data = (await (await read(['Poutine'])).json()) as any;
    expect(data.ratings.poutine.average).toBe(4.3);
  });

  test('rejects a rater id that is missing or malformed', async () => {
    expect((await rate('Poutine', 4, null)).status).toBe(400);
    expect((await rate('Poutine', 4, 'has spaces')).status).toBe(400);
    expect((await rate('Poutine', 4, 'x'.repeat(65))).status).toBe(400);
  });
});

describe('writing ratings', () => {
  test('re-rating replaces the previous value instead of adding one', async () => {
    expect(await (await rate('Poutine', 5)).json()).toMatchObject({
      rating: { count: 1, average: 5, myRating: 5 }
    });
    expect(await (await rate('Poutine', 2)).json()).toMatchObject({
      rating: { count: 1, average: 2, myRating: 2 }
    });
  });

  test('validates the dish and the star value', async () => {
    for (const rating of [0, 6, 2.5, 'three', null, undefined]) {
      expect((await rate('Poutine', rating)).status).toBe(400);
    }
    expect((await rate('   ', 4)).status).toBe(400);
    expect((await rate('x'.repeat(141), 4)).status).toBe(400);
    expect((await worker.fetch(req('/api/ratings', 'POST', { rating: 4 }), env)).status).toBe(400);
    expect((await worker.fetch(req('/api/ratings', 'POST', undefined), env)).status).toBe(400);
  });

  test('dish names are matched case- and space-insensitively', async () => {
    await rate('Scrambled Eggs', 5);
    await rate('  scrambled   eggs ', 3);
    const data = (await (await read(['Scrambled Eggs'])).json()) as any;
    expect(data.ratings['scrambled eggs'].count).toBe(1);
    expect(data.ratings['scrambled eggs'].myRating).toBe(3);
  });

  test('a rater is capped per day', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.RATINGS_DB
      .prepare('INSERT INTO rater_writes (rater_id, day, count) VALUES (?, ?, 300)')
      .bind(RATER, day)
      .run();
    expect((await rate('One Too Many', 4)).status).toBe(429);
    // A different rater on the same day is unaffected.
    expect((await rate('One Too Many', 4, 'rater-2')).status).toBe(200);
  });
});

describe('removing ratings', () => {
  const remove = (dish: unknown, raterId: string | null = RATER) =>
    worker.fetch(req('/api/ratings', 'DELETE', { dish }, raterId), env);

  test('clears only the caller own rating and returns the new aggregate', async () => {
    await rate('Scrambled Eggs', 5);
    await rate('Scrambled Eggs', 3, 'rater-2');
    await rate('Scrambled Eggs', 4, 'rater-3');

    const after = (await (await remove('Scrambled Eggs')).json()) as any;
    expect(after.rating).toEqual({ count: 2, average: 3.5, myRating: null });

    const mine = (await (await read(['scrambled eggs'])).json()) as any;
    expect(mine.ratings['scrambled eggs']).toEqual({ count: 2, average: 3.5, myRating: null });
    // Another rater's rating is untouched.
    const other = (await (await read(['scrambled eggs'], 'rater-2')).json()) as any;
    expect(other.ratings['scrambled eggs'].myRating).toBe(3);
  });

  test('deleting the last rating leaves the dish unrated', async () => {
    await rate('Poutine', 4);
    const after = (await (await remove('Poutine')).json()) as any;
    expect(after.rating).toEqual({ count: 0, average: 0, myRating: null });

    // A dish with no ratings is absent from the read map, as before this change.
    const data = (await (await read(['Poutine'])).json()) as any;
    expect(data.ratings.poutine).toBeUndefined();
    expect(data.ratings).toEqual({});
  });

  test('deleting a rating does not refund the daily write cap', async () => {
    // The cap counts writes, not net ratings, so deleting and re-rating must
    // not let a rater past it.
    await rate('Scrambled Eggs', 5);
    await remove('Scrambled Eggs');
    await rate('Scrambled Eggs', 4);

    const day = new Date().toISOString().slice(0, 10);
    const usage = await env.RATINGS_DB
      .prepare('SELECT count FROM rater_writes WHERE rater_id = ? AND day = ?')
      .bind(RATER, day)
      .first<{ count: number }>();
    expect(Number(usage?.count)).toBe(2);
  });

  test('deleting a rating you never made is a no-op, not an error', async () => {
    await rate('Poutine', 4, 'rater-2');
    const response = await remove('Poutine');
    expect(response.status).toBe(200);
    const after = (await response.json()) as any;
    expect(after.rating).toEqual({ count: 1, average: 4, myRating: null });
  });

  test('matches dish names case- and space-insensitively', async () => {
    await rate('Scrambled Eggs', 5);
    const response = await remove('  scrambled   eggs ');
    expect(response.status).toBe(200);
    const after = (await response.json()) as any;
    expect(after.rating).toEqual({ count: 0, average: 0, myRating: null });
  });

  test('requires a rater id and a valid dish', async () => {
    expect((await remove('Poutine', null)).status).toBe(400);
    expect((await remove('Poutine', 'has spaces')).status).toBe(400);
    expect((await remove('   ')).status).toBe(400);
    expect((await remove('x'.repeat(141))).status).toBe(400);
    expect((await worker.fetch(req('/api/ratings', 'DELETE', undefined), env)).status).toBe(400);
  });

  test('after clearing, the rater can rate the dish again', async () => {
    await rate('Poutine', 5);
    await remove('Poutine');
    expect(await (await rate('Poutine', 2)).json()).toMatchObject({
      rating: { count: 1, average: 2, myRating: 2 }
    });
  });
});

describe('cataloguing', () => {
  test('records each dish once and keeps ratings across days', async () => {
    expect(await (await catalog('2026-09-25', ['Scrambled Eggs', 'scrambled eggs', 'Poutine'])).json())
      .toEqual({ catalogued: 2 });
    await rate('Poutine', 5);

    expect(await (await catalog('2026-09-26', ['Poutine', 'Naan Bread'])).json())
      .toEqual({ catalogued: 2 });

    const listed = (await (await worker.fetch(req('/api/dishes'), env)).json()) as any;
    const poutine = listed.dishes.find((dish: any) => dish.id === 'poutine');
    expect(poutine).toMatchObject({ name: 'Poutine', firstSeen: '2026-09-25', lastSeen: '2026-09-26', count: 1, average: 5 });

    const days = await env.RATINGS_DB
      .prepare('SELECT day FROM dish_days WHERE dish_id = ? ORDER BY day')
      .bind('poutine')
      .all<{ day: string }>();
    expect((days.results ?? []).map((row) => row.day)).toEqual(['2026-09-25', '2026-09-26']);
  });

  test('validates the date and the dish list', async () => {
    expect((await catalog('25-09-2026', ['Poutine'])).status).toBe(400);
    expect((await catalog('2026-09-25', 'Poutine')).status).toBe(400);
    expect(await (await catalog('2026-09-25', [])).json()).toEqual({ catalogued: 0 });
    expect(await (await catalog('2026-09-25', [42, '', '  '])).json()).toEqual({ catalogued: 0 });
  });
});

describe('routing', () => {
  test('answers preflight and rejects unknown routes', async () => {
    const options = await worker.fetch(req('/api/ratings', 'OPTIONS'), env);
    expect(options.status).toBe(204);
    expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');

    expect((await worker.fetch(req('/api/nope'), env)).status).toBe(404);
    expect((await worker.fetch(req('/api/dishes', 'DELETE'), env)).status).toBe(404);
  });

  test('DELETE is advertised in the CORS methods', async () => {
    const options = await worker.fetch(req('/api/ratings', 'OPTIONS'), env);
    expect(options.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });

  test('GET responses carry CORS so an iframe on another site can read them', async () => {
    const response = await read(['Poutine']);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('dashboard stats', () => {
  const stats = () => worker.fetch(req('/api/stats'), env);

  // Ratings are stamped with the real clock, so a stats call pinned to a fixed
  // past date makes "today" deterministically empty.
  const statsOn = (date: string, offset = '0') =>
    worker.fetch(req(`/api/stats?date=${date}&offset=${offset}`), env);

  test('reports zeroes on an empty database rather than dividing by zero', async () => {
    const body = await bodyOf(await stats());
    expect(body).toMatchObject({
      totalRatings: 0,
      raters: 0,
      catalogue: 0,
      ratedDishes: 0,
      ratingsPerRater: 0,
      stations: [],
      today: { totalRatings: 0, raters: 0, ratedDishes: 0, ratingsPerRater: 0 }
    });
  });

  test('breaks the numbers down per kitchen station', async () => {
    const cataloged = await bodyOf(await catalog('2026-09-28', undefined, {
      'Global Fare': ['Salmon', 'Poutine'],
      'Classic Kitchen': ['Salmon', 'Meatloaf']
    }));
    expect(cataloged.catalogued).toBe(3);

    await rate('Salmon', 5, 'rater-a');   // on both sides
    await rate('Poutine', 3, 'rater-a');  // Global Fare only
    await rate('Meatloaf', 1, 'rater-b'); // Classic Kitchen only

    const body = await bodyOf(await stats());
    const byStation = Object.fromEntries(body.stations.map((s: { station: string }) => [s.station, s]));

    // Salmon sits on both sides, so it counts on both.
    expect(byStation['Global Fare'].ratings).toBe(2);
    expect(byStation['Global Fare'].raters).toBe(1);
    expect(byStation['Global Fare'].average).toBe(4); // (5 + 3) / 2

    expect(byStation['Classic Kitchen'].ratings).toBe(2);
    expect(byStation['Classic Kitchen'].raters).toBe(2);
    expect(byStation['Classic Kitchen'].average).toBe(3); // (5 + 1) / 2

    // Per-side numbers are not a partition of the total.
    expect(body.stations.reduce((n: number, s: { ratings: number }) => n + s.ratings, 0)).toBe(4);
    expect(body.totalRatings).toBe(3);
  });

  test('a dish served across several days is not counted once per day', async () => {
    for (const day of ['2026-09-26', '2026-09-27', '2026-09-28']) {
      await catalog(day, undefined, { 'Global Fare': ['Salmon'] });
    }
    await rate('Salmon', 4, 'rater-a');

    // Pinned to a day with no ratings, so `today` is empty and the all-time
    // station numbers are what is under test.
    const body = await bodyOf(await statsOn('2020-01-01'));
    expect(body.stations).toEqual([
      {
        station: 'Global Fare',
        ratings: 1,
        raters: 1,
        average: 4,
        today: { ratings: 0, raters: 0, average: 0 }
      }
    ]);
  });

  test('folds the two spellings of Classic Kitchen into one side', async () => {
    await catalog('2026-09-27', undefined, { 'Classic Kitchen': ['Meatloaf'] });
    await catalog('2026-09-28', undefined, { classicKitchen: ['Poutine'] });
    await rate('Meatloaf', 5, 'rater-a');
    await rate('Poutine', 3, 'rater-a');

    const body = await bodyOf(await statsOn('2020-01-01'));
    expect(body.stations).toEqual([
      {
        station: 'Classic Kitchen',
        ratings: 2,
        raters: 1,
        average: 4,
        today: { ratings: 0, raters: 0, average: 0 }
      }
    ]);
  });

  test('a dish with no station reported does not appear in any side', async () => {
    await catalog('2026-09-28', ['Mystery Dish']);
    await rate('Mystery Dish', 5, 'rater-a');

    const body = await bodyOf(await stats());
    expect(body.totalRatings).toBe(1);
    expect(body.stations).toEqual([]);
  });

  test('counts ratings, distinct raters and distinct rated dishes', async () => {
    await catalog('2026-09-28', ['Salmon', 'Poutine', 'Unrated Dish']);
    await rate('Salmon', 5, 'rater-a');
    await rate('Salmon', 3, 'rater-b');
    await rate('Poutine', 4, 'rater-a');

    const body = await (await stats()).json();
    expect(body.totalRatings).toBe(3);
    expect(body.raters).toBe(2);
    expect(body.ratedDishes).toBe(2);
    expect(body.catalogue).toBe(3);
    // 3 ratings across 2 raters.
    expect(body.ratingsPerRater).toBe(1.5);
  });

  test('re-rating one dish does not inflate the rater count', async () => {
    await rate('Salmon', 5, 'rater-a');
    await rate('Salmon', 1, 'rater-a');

    const body = await (await stats()).json();
    expect(body.totalRatings).toBe(1);
    expect(body.raters).toBe(1);
  });

  test('deleting a rating updates the totals', async () => {
    await rate('Salmon', 5, 'rater-a');
    await rate('Poutine', 4, 'rater-b');
    await worker.fetch(req('/api/ratings', 'DELETE', { dish: 'Salmon' }, 'rater-a'), env);

    const body = await (await stats()).json();
    expect(body.totalRatings).toBe(1);
    expect(body.raters).toBe(1);
    expect(body.ratedDishes).toBe(1);
  });

  test('stats are readable cross-origin and reject other methods', async () => {
    const response = await stats();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await worker.fetch(req('/api/stats', 'POST'), env)).status).toBe(404);
  });

  test('creates dish_stations on demand for a database that predates it', async () => {
    // Simulate the live database before this feature existed: the table is gone.
    await env.RATINGS_DB.prepare('DROP TABLE IF EXISTS dish_stations').run();

    // Stats must still answer rather than 500 while the table is missing.
    expect((await stats()).status).toBe(200);

    // Cataloguing recreates it, and the station then appears.
    await catalog('2026-09-28', undefined, { 'Global Fare': ['Salmon'] });
    await rate('Salmon', 5, 'rater-a');

    const body = await bodyOf(await statsOn('2020-01-01'));
    expect(body.stations).toEqual([
      {
        station: 'Global Fare',
        ratings: 1,
        raters: 1,
        average: 5,
        today: { ratings: 0, raters: 0, average: 0 }
      }
    ]);
  });

  test('all-time totals ignore the date, and today counts only today casts', async () => {
    await rate('Salmon', 5, 'rater-a');
    await rate('Poutine', 3, 'rater-b');

    // A day with no ratings yet: all-time holds, today is empty.
    const past = await bodyOf(await statsOn('2020-01-01'));
    expect(past.totalRatings).toBe(2);
    expect(past.today).toEqual({
      totalRatings: 0,
      raters: 0,
      ratedDishes: 0,
      average: 0,
      ratingsPerRater: 0
    });

    // The real local day: both ratings were cast now, so today sees both.
    const localDate = new Date().toLocaleDateString('en-CA');
    const offset = new Date().getTimezoneOffset();
    const now = await bodyOf(await statsOn(localDate, String(offset)));
    expect(now.today.totalRatings).toBe(2);
    expect(now.today.raters).toBe(2);
    expect(now.today.ratedDishes).toBe(2);
    expect(now.today.ratingsPerRater).toBe(1);
  });

  test('a timezone offset moves a rating between days', async () => {
    await rate('Salmon', 5, 'rater-a');

    // A rating cast now is inside today's UTC day, so a UTC-scoped call sees it.
    const utcDate = new Date().toISOString().slice(0, 10);
    const todayAtUtc = await bodyOf(await statsOn(utcDate, '0'));
    expect(todayAtUtc.today.totalRatings).toBe(1);

    // The previous UTC day ended before the rating, so it cannot contain it.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const emptyYesterday = await bodyOf(await statsOn(yesterday, '0'));
    expect(emptyYesterday.today.totalRatings).toBe(0);
  });

  test('today scope lists only dishes served today, with only today ratings', async () => {
    // Fixed past days, so this never collides with the real local date.
    await catalog('2020-01-01', undefined, { 'Global Fare': ['Old Dish'] });
    await catalog('2020-01-02', undefined, { 'Global Fare': ['Older Dish'] });
    await rate('Old Dish', 5, 'rater-a');
    await rate('Older Dish', 4, 'rater-b');

    const all = await bodyOf(await worker.fetch(req('/api/dishes?scope=all'), env));
    expect(all.scope).toBe('all');
    expect(all.dishes.map((d: { name: string }) => d.name).sort()).toEqual([
      'Old Dish',
      'Older Dish'
    ]);

    // Neither dish was served on the real local date, so the today listing is
    // empty even though both have ratings.
    const localDate = new Date().toLocaleDateString('en-CA');
    const today = await bodyOf(
      await worker.fetch(req(`/api/dishes?scope=today&date=${localDate}`), env)
    );
    expect(today.scope).toBe('today');
    expect(today.dishes).toEqual([]);
  });

  test('today scope includes dishes served today, with their today ratings', async () => {
    const localDate = new Date().toLocaleDateString('en-CA');
    await catalog(localDate, undefined, { 'Global Fare': ['Fresh Dish', 'Quiet Dish'] });
    await rate('Fresh Dish', 5, 'rater-a');

    const body = await bodyOf(
      await worker.fetch(req(`/api/dishes?scope=today&date=${localDate}`), env)
    );
    expect(body.dishes.map((d: { name: string }) => d.name).sort()).toEqual([
      'Fresh Dish',
      'Quiet Dish'
    ]);
    const fresh = body.dishes.find((d: { name: string }) => d.name === 'Fresh Dish');
    expect(fresh.count).toBe(1);
    expect(fresh.average).toBe(5);
    // A dish on today's menu that nobody rated today stays listed at zero,
    // rather than vanishing from the day's view.
    const quiet = body.dishes.find((d: { name: string }) => d.name === 'Quiet Dish');
    expect(quiet.count).toBe(0);
    expect(quiet.average).toBeNull();
  });
});

describe('rating history', () => {
  const history = (query: string) =>
    worker.fetch(req(`/api/ratings/history?${query}`), env);

  test('needs a dish or a station', async () => {
    expect((await history('')).status).toBe(400);
    expect((await history('station=Nonsense')).status).toBe(400);
    expect((await history('dish=   ')).status).toBe(400);
  });

  test('totals a dish history and returns the running average', async () => {
    await catalog('2026-09-28', undefined, { 'Global Fare': ['Salmon'] });
    await rate('Salmon', 5, 'rater-a');
    await rate('Salmon', 3, 'rater-b');
    await rate('Salmon', 1, 'rater-c');

    const body = await bodyOf(await history('dish=Salmon'));
    expect(body.scope).toBe('dish');
    expect(body.label).toBe('Salmon');
    expect(body.count).toBe(3);
    expect(body.average).toBe(3); // (5 + 3 + 1) / 3
    // The three casts land in the same minute (or two, if the clock ticks over
    // mid-test), so assert on the final point rather than the point count.
    expect(body.timeline.length).toBeGreaterThan(0);
    expect(body.timeline.at(-1)).toMatchObject({ count: 3, average: 3, running: 3, runningCount: 3 });
    expect(body.timeline.at(-1).day).toBe(new Date().toLocaleDateString('en-CA'));
    // Newest first, and the raw rater id is truncated to a prefix.
    expect(body.ratings).toHaveLength(3);
    expect(body.ratings.map((r: { rating: number }) => r.rating).sort()).toEqual([1, 3, 5]);
    for (const row of body.ratings) {
      expect(row.rater.length).toBeLessThanOrEqual(8);
      expect(row.updatedAt).toBeGreaterThan(0);
    }
  });

  test('an uncatalogued dish still resolves by its normalised name', async () => {
    await rate('Mystery Dish', 4, 'rater-a');
    const body = await bodyOf(await history('dish=Mystery%20Dish'));
    expect(body.label).toBe('mystery dish');
    expect(body.count).toBe(1);
    expect(body.timeline[0].average).toBe(4);
  });

  test('totals a station history across its dishes', async () => {
    await catalog('2026-09-28', undefined, {
      'Global Fare': ['Salmon', 'Poutine'],
      'Classic Kitchen': ['Meatloaf']
    });
    await rate('Salmon', 5, 'rater-a');
    await rate('Poutine', 3, 'rater-a');
    await rate('Meatloaf', 1, 'rater-b');

    const body = await bodyOf(await history('station=Global%20Fare'));
    expect(body.scope).toBe('station');
    expect(body.label).toBe('Global Fare');
    expect(body.count).toBe(2);
    expect(body.average).toBe(4); // (5 + 3) / 2
    // Station histories are graph-only; they do not list individual ratings.
    expect(body.ratings).toEqual([]);
  });

  test('folds a station spelling and rejects an unknown one', async () => {
    await catalog('2026-09-28', undefined, { classicKitchen: ['Meatloaf'] });
    await rate('Meatloaf', 4, 'rater-a');

    const folded = await bodyOf(await history('station=Classic%20Kitchen'));
    expect(folded.label).toBe('Classic Kitchen');
    expect(folded.count).toBe(1);

    expect((await history('station=Global%20Fare')).status).toBe(200);
  });

  test('a dish with no ratings reports an empty timeline', async () => {
    const body = await bodyOf(await history('dish=Nothing%20Rated'));
    expect(body.count).toBe(0);
    expect(body.average).toBe(0);
    expect(body.timeline).toEqual([]);
    expect(body.ratings).toEqual([]);
  });

  test('buckets points by minute, not by day', async () => {
    // Three ratings inside one calendar day, each in its own minute. A day
    // bucket would collapse these to a single point.
    const at = (minute: number) => Date.parse(`2026-09-28T12:${String(minute).padStart(2, '0')}:00Z`);
    await env.RATINGS_DB.batch([
      env.RATINGS_DB
        .prepare('INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at) VALUES (?, ?, ?, ?)')
        .bind('salmon', 'rater-a', 5, at(1)),
      env.RATINGS_DB
        .prepare('INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at) VALUES (?, ?, ?, ?)')
        .bind('salmon', 'rater-b', 3, at(4)),
      env.RATINGS_DB
        .prepare('INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at) VALUES (?, ?, ?, ?)')
        .bind('salmon', 'rater-c', 1, at(9))
    ]);

    const body = await bodyOf(await history('dish=Salmon'));
    expect(body.timeline).toHaveLength(3);
    expect(body.timeline.map((p: any) => p.minute)).toEqual([
      '2026-09-28T12:01',
      '2026-09-28T12:04',
      '2026-09-28T12:09'
    ]);
    // Every point still knows which day it belongs to.
    for (const point of body.timeline) expect(point.day).toBe('2026-09-28');
    // The running average walks 5 -> 4 -> 3 as each rating lands.
    expect(body.timeline.map((p: any) => p.running)).toEqual([5, 4, 3]);
    expect(body.timeline.map((p: any) => p.runningCount)).toEqual([1, 2, 3]);
    // A point sits at the start of its minute, and keeps the real instant it
    // was bucketed from.
    expect(body.timeline[0].rawAt).toBe(at(1));
    expect(body.timeline[0].at).toBe(at(1)); // an exact minute floors to itself
  });

  test('a bucket sits at the start of its minute', async () => {
    const ts = Date.parse('2026-09-28T12:01:47Z');
    await env.RATINGS_DB
      .prepare('INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at) VALUES (?, ?, ?, ?)')
      .bind('salmon', 'rater-a', 4, ts)
      .run();

    const body = await bodyOf(await history('dish=Salmon'));
    expect(body.timeline[0].minute).toBe('2026-09-28T12:01');
    expect(body.timeline[0].rawAt).toBe(ts);
    expect(body.timeline[0].at).toBe(Date.parse('2026-09-28T12:01:00Z'));
  });

  test('ratings in the same minute share a point', async () => {
    const at = (seconds: number) => Date.parse('2026-09-28T12:03:00Z') + seconds * 1000;
    await env.RATINGS_DB.batch([
      env.RATINGS_DB
        .prepare('INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at) VALUES (?, ?, ?, ?)')
        .bind('salmon', 'rater-a', 5, at(5)),
      env.RATINGS_DB
        .prepare('INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at) VALUES (?, ?, ?, ?)')
        .bind('salmon', 'rater-b', 1, at(40))
    ]);

    const body = await bodyOf(await history('dish=Salmon'));
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0]).toMatchObject({ count: 2, average: 3, running: 3, runningCount: 2 });
    expect(body.timeline[0].minute).toBe('2026-09-28T12:03');
  });

  test('a timezone offset buckets a rating into the caller day', async () => {
    // 2026-09-29T02:30Z is 22:30 on the 28th at UTC-4. Both the bucket and its
    // day must follow the caller, not UTC.
    await env.RATINGS_DB
      .prepare('INSERT INTO dish_ratings (dish_id, rater_id, rating, updated_at) VALUES (?, ?, ?, ?)')
      .bind('salmon', 'rater-a', 5, Date.parse('2026-09-29T02:30:00Z'))
      .run();

    const body = await bodyOf(await history('dish=Salmon&date=2026-09-28&offset=240'));
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0].minute).toBe('2026-09-28T22:30');
    expect(body.timeline[0].day).toBe('2026-09-28');
  });

  test('history is readable cross-origin', async () => {
    const response = await history('dish=Salmon');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('meal periods', () => {
  const catalogPeriods = (date: string, periods: unknown, stations?: unknown) =>
    worker.fetch(req('/api/dishes/catalog', 'POST', { date, dishes: [], stations, periods }), env);
  const history = (query: string) => worker.fetch(req(`/api/ratings/history?${query}`), env);

  test('records the meals a dish was listed in and folds it into the stats', async () => {
    await catalogPeriods('2026-09-25', {
      breakfast: ['Scrambled Eggs', 'Oatmeal'],
      dinner: ['Scrambled Eggs', 'Poutine']
    });
    await rate('Scrambled Eggs', 5, 'rater-a');
    await rate('Poutine', 3, 'rater-b');

    const stats = await bodyOf(await worker.fetch(req('/api/stats'), env));
    const byName = Object.fromEntries(stats.periods.map((p: any) => [p.period, p]));
    // Scrambled Eggs was at both meals, so it counts toward both — a per-meal
    // view, not a partition of the totals.
    expect(byName.breakfast).toMatchObject({ ratings: 1, raters: 1, dishes: 1, average: 5 });
    expect(byName.dinner).toMatchObject({ ratings: 2, raters: 2, dishes: 2, average: 4 });
  });

  test('lists every period even when nothing was rated in it', async () => {
    await catalogPeriods('2026-09-25', { lunch: ['Tacos'] });

    const stats = await bodyOf(await worker.fetch(req('/api/stats'), env));
    expect(stats.periods.map((p: any) => p.period)).toEqual(['breakfast', 'lunch', 'dinner']);
    const breakfast = stats.periods.find((p: any) => p.period === 'breakfast');
    expect(breakfast).toMatchObject({ ratings: 0, raters: 0, dishes: 0, average: 0 });
  });

  test('rejects an unknown period rather than recording it', async () => {
    await catalogPeriods('2026-09-25', { brunch: ['Tacos'], dinner: ['Poutine'] });
    const rows = await env.RATINGS_DB
      .prepare('SELECT period FROM dish_periods ORDER BY period')
      .all<{ period: string }>();
    expect((rows.results ?? []).map((r) => r.period)).toEqual(['dinner']);
  });

  test('filters the dish list by period, all-time and today', async () => {
    // Stations are sent alongside the meals because `scope=today` also requires
    // a station row for the day — that is the existing contract for "served
    // today", and the widget always sends both.
    await catalogPeriods(
      '2026-09-25',
      { breakfast: ['Scrambled Eggs'], dinner: ['Poutine'] },
      { 'Global Fare': ['Scrambled Eggs', 'Poutine'] }
    );
    await catalogPeriods('2026-09-26', { dinner: ['Naan Bread'] }, { 'Global Fare': ['Naan Bread'] });

    const breakfast = await bodyOf(await worker.fetch(req('/api/dishes?period=breakfast'), env));
    expect(breakfast.dishes.map((d: any) => d.id)).toEqual(['scrambled eggs']);
    expect(breakfast.period).toBe('breakfast');

    // All-time means "ever listed under that meal", so a dinner dish from an
    // earlier day is still there.
    const dinner = await bodyOf(await worker.fetch(req('/api/dishes?period=dinner'), env));
    expect(dinner.dishes.map((d: any) => d.id).sort()).toEqual(['naan bread', 'poutine']);

    // Today narrows to that day's meal, so only the dish served that evening.
    const todayDinner = await bodyOf(
      await worker.fetch(req('/api/dishes?period=dinner&scope=today&date=2026-09-26&offset=240'), env)
    );
    expect(todayDinner.dishes.map((d: any) => d.id)).toEqual(['naan bread']);
  });

  test('rejects an unknown period in the dish list and history', async () => {
    expect((await worker.fetch(req('/api/dishes?period=brunch'), env)).status).toBe(400);
    expect((await worker.fetch(req('/api/ratings/history?period=brunch'), env)).status).toBe(400);
  });

  test('graphs a period timeline across its dishes', async () => {
    await catalogPeriods('2026-09-25', { dinner: ['Poutine', 'Naan Bread'] });
    await rate('Poutine', 5, 'rater-a');
    await rate('Naan Bread', 3, 'rater-b');

    const body = await bodyOf(await history('period=dinner'));
    expect(body.scope).toBe('period');
    expect(body.label).toBe('dinner');
    expect(body.count).toBe(2);
    expect(body.average).toBe(4);
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0].runningCount).toBe(2);
    // A meal is a side, not a dish, so there is no individual-rating list.
    expect(body.ratings).toEqual([]);
  });

  test('creates dish_periods on demand for a database that predates it', async () => {
    await env.RATINGS_DB.prepare('DROP TABLE IF EXISTS dish_periods').run();
    await catalogPeriods('2026-09-25', { lunch: ['Tacos'] });
    const stats = await bodyOf(await worker.fetch(req('/api/stats'), env));
    expect(stats.periods.find((p: any) => p.period === 'lunch').dishes).toBe(0);
    const rows = await env.RATINGS_DB.prepare('SELECT COUNT(*) AS n FROM dish_periods').first<{ n: number }>();
    expect(Number(rows?.n)).toBe(1);
  });
});

describe('static sections', () => {
  const catalogSections = (date: string, stations: unknown) =>
    worker.fetch(req('/api/dishes/catalog', 'POST', { date, dishes: [], stations }), env);
  const history = (query: string) => worker.fetch(req(`/api/ratings/history?${query}`), env);

  test('break the ratings down per static section like a station', async () => {
    await catalogSections('2026-09-25', {
      'Global Fare': ['Salmon'],
      Soupside: ['Daily Soup'],
      Greens: ['Salad'],
      Sandwich: ['Sandwich']
    });
    await rate('Salmon', 5, 'rater-a');
    await rate('Daily Soup', 4, 'rater-b');
    await rate('Salad', 2, 'rater-c');
    await rate('Sandwich', 3, 'rater-d');

    const stats = await bodyOf(await worker.fetch(req('/api/stats'), env));
    const byStation = Object.fromEntries(stats.stations.map((s: any) => [s.station, s]));
    expect(byStation.Soupside).toMatchObject({ ratings: 1, average: 4 });
    expect(byStation.Greens).toMatchObject({ ratings: 1, average: 2 });
    expect(byStation.Sandwich).toMatchObject({ ratings: 1, average: 3 });
    // The sections are counted alongside the daily stations, not instead of.
    expect(byStation['Global Fare'].ratings).toBe(1);
  });

  test('graphs a static section timeline', async () => {
    await catalogSections('2026-09-25', { Greens: ['Salad', 'Fruit Cup'] });
    await rate('Salad', 5, 'rater-a');
    await rate('Fruit Cup', 3, 'rater-b');

    const body = await bodyOf(await history('station=Greens'));
    expect(body.label).toBe('Greens');
    expect(body.count).toBe(2);
    expect(body.average).toBe(4);
    expect(body.timeline).toHaveLength(1);
    // A section holds several dishes, so it is graphed, not itemised.
    expect(body.ratings).toEqual([]);
  });

  test('accepts each section name and still rejects a stranger', async () => {
    for (const name of ['Soupside', 'Sauce + Stone', 'Greens', 'Sandwich']) {
      expect((await worker.fetch(req(`/api/ratings/history?station=${encodeURIComponent(name)}`), env)).status).toBe(200);
    }
    expect((await worker.fetch(req('/api/ratings/history?station=Fryolator'), env)).status).toBe(400);
  });
});

describe('ratings per day', () => {
  const daily = (query = '') => worker.fetch(req(`/api/ratings/daily?${query}`), env);

  test('counts the ratings cast on each day and fills the quiet days', async () => {
    // Rating timestamps come from Date.now(), so catalogue "today" and rate
    // against it: all three ratings land on the same local day.
    const today = new Date().toLocaleDateString('en-CA');
    await catalog(today, ['Salmon', 'Poutine']);
    const date = new Date().toLocaleDateString('en-CA');
    await rate('Salmon', 5, 'rater-a');
    await rate('Salmon', 4, 'rater-b');
    await rate('Poutine', 3, 'rater-c');

    const body = await bodyOf(await daily(`date=${date}&offset=0`));
    const day = body.days.find((d: any) => d.day === date);
    expect(day.count).toBe(3);
    expect(body.total).toBe(3);
  });

  test('narrows to a meal', async () => {
    await catalogPeriodsForDaily();
    const date = new Date().toLocaleDateString('en-CA');
    await rate('Poutine', 5, 'rater-a'); // dinner
    await rate('Tacos', 4, 'rater-b'); // lunch

    const all = await bodyOf(await daily(`date=${date}&offset=0`));
    expect(all.total).toBe(2);
    const dinner = await bodyOf(await daily(`date=${date}&offset=0&period=dinner`));
    expect(dinner.total).toBe(1);
    expect(dinner.period).toBe('dinner');
  });

  test('narrows to a static section category', async () => {
    const date = new Date().toLocaleDateString('en-CA');
    await worker.fetch(
      req('/api/dishes/catalog', 'POST', { date, dishes: [], stations: { Greens: ['Salad'] } }),
      env
    );
    await rate('Salad', 5, 'rater-a');

    const body = await bodyOf(await daily(`date=${date}&offset=0&category=Greens`));
    expect(body.category).toBe('Greens');
    expect(body.total).toBe(1);
  });

  test('rejects an unknown meal or category', async () => {
    expect((await daily('period=brunch')).status).toBe(400);
    expect((await daily('category=Fryolator')).status).toBe(400);
  });

  test('returns an empty range rather than failing when nothing is rated', async () => {
    const body = await bodyOf(await daily('date=2000-01-01&offset=0'));
    expect(body.days).toEqual([]);
    expect(body.total).toBe(0);
  });
});

// Rates against a catalogue that puts one dish at lunch and one at dinner.
async function catalogPeriodsForDaily() {
  const date = new Date().toLocaleDateString('en-CA');
  await worker.fetch(
    req('/api/dishes/catalog', 'POST', {
      date,
      dishes: [],
      periods: { lunch: ['Tacos'], dinner: ['Poutine'] }
    }),
    env
  );
}
