# Hilltoppers Menu

Standalone menu page for Saint Johnsbury Academy dining — designed for GitHub Pages hosting and iframe embedding.

## Live

**GitHub Pages:** https://amos-donn.github.io/hilltoppers-menu/

## Features

- **Three dining periods:** Breakfast, Lunch, Dinner
- **Two kitchen stations:** Global Fare, Classic Kitchen — always side by side, including in a narrow iframe
- **Four static sections below them:** Soupside, Sauce + Stone, Greens, Sandwich — the same every day, in two rows (Soupside and Sauce + Stone on top, Greens and Sandwich below), behind a divider and the note "These foods are static — they don't change day-to-day." They are listed in `STATIC_SECTIONS` in `index.html` rather than read from the daily feed, and are rateable like any other dish. They are shown without a source link, since the dining site does not list them.
- **Always visible:** no dropdown or collapse control; the widget renders its content directly
- **Day navigation:** step through published menu dates with the arrows next to the Menu Website link
- **Source links:** every dish links to the day it is served on, on the original dining site
- **Star ratings:** each dish shows its average rating under its title as read-only stars; the rating row is a button that opens a dialog to rate it
- **Confirm-before-save:** the dialog previews a value as you hover or focus a star, keeps Save disabled until you pick one, and lets Cancel, Escape, or an outside click discard without saving
- **Shared ratings:** once the Worker URL is set, ratings are shared between everyone rather than stored per browser
- **Menu and dashboard as tabs:** `index.html` puts the widget and the ratings dashboard behind a Menu/Dashboard tab bar, so each gets the full page rather than sharing it side by side. Both panes stay in the DOM, so switching is instant and the dashboard keeps polling in the background. The dashboard has a scope toggle (all-time vs. today), a meal filter (all meals, breakfast, lunch or dinner) and a category filter (any station or static section), per-side and per-meal stat cards showing both scopes with stars and a trend graph, five stat cards for the selected meal, a ratings-per-day volume histogram for the chosen meal and category, and clickable dish rows that expand into the individual ratings behind the average plus a rating-over-time chart. The old standalone `dashboard.html` is now a redirect to the site root, kept only so an old bookmark or link still lands somewhere.
- **Site chrome:** a mark in the top-right — the logo (also the favicon) beside "Menu Ratings", with "menu / alt - a hilltoppers/alt project" beneath it.
- **One page, two shapes:** embedded in the extension iframe (detected from the `host`/`session` params) the page is the widget alone — the tab bar and the dashboard pane are hidden, and the widget's footer keeps its "View stats" link, which opens the site's dashboard tab in a new tab.
- **Live data:** the menu and the ratings refresh on their own, and again the moment the tab regains focus
- **Iframe-safe:** all styles inline, no external dependencies

## How updates reach users

Three things have to line up for a new menu to appear, and all three are handled:

1. **`scripts/fetch-menu.mjs`** reads the dining site and writes `menu.json`. It only writes when the menu actually changed, so an idle run makes no commit.
2. **`.github/workflows/update-menu.yml`** runs that script every 5 minutes and commits `menu.json` when it changed. This is the main lever on how fast new data lands — see *Keeping updates fast* below.
3. **`index.html`** polls for the file (revalidating with an ETag, so a poll with nothing new costs a 304, not a download) and re-reads it on focus, visibility change, and reconnect.

## Keeping updates fast

The widget can only be as current as the file it reads, so the schedule matters:

- The cron interval in `.github/workflows/update-menu.yml` sets the floor on update latency. Five minutes is close to the shortest interval GitHub honours reliably; GitHub's scheduler can still lag a few minutes under load.
- For tighter latency, point a scheduler you control (an uptime pinger, a Cloudflare Worker cron, a `cron` on a server) at the `workflow_dispatch` endpoint so runs happen on a clock you own.
- GitHub Pages caches assets for a few minutes. The widget revalidates on every poll, so it picks up a new `menu.json` as soon as Pages serves it.

**GitHub Pages must be configured to serve from the repository root (`/`).** If Pages is set to a branch folder such as `/docs`, every build fails and the site keeps serving stale content — which is indistinguishable from "the menu never updates".

## Ratings backend

Ratings need shared storage, so they live in a Cloudflare Worker with a D1 database. The widget works without it (falling back to ratings stored in that browser) and switches to shared ratings as soon as the Worker URL is set.

```
worker/
  schema.sql          tables: dishes, dish_days, dish_stations, dish_periods, dish_ratings, rater_writes
  src/ratings.ts      the API: read, rate, catalogue
  src/http.ts         CORS + JSON helpers
  src/index.ts        entry point
  src/ratings.test.ts tests, run against a real D1 database
  wrangler.toml       Worker + D1 binding
```

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ratings?dishes=a,b` | Count, average, and (with `X-Rater-ID`) the caller's own rating |
| `POST` | `/api/ratings` | Record a rating; body `{ "dish": "...", "rating": 1-5 }` |
| `DELETE` | `/api/ratings` | Remove the caller's own rating; body `{ "dish": "..." }` |
| `POST` | `/api/dishes/catalog` | Record the dishes served on a day; body `{ "date": "...", "dishes": [...] }`, optionally grouped by station as `"stations": { "Global Fare": [...], "Classic Kitchen": [...] }` and by meal as `"periods": { "breakfast": [...], "lunch": [...], "dinner": [...] }` |
| `GET` | `/api/dishes` | The whole catalogue with ratings, for inspection. `scope=today` narrows it to dishes served on the request's day; `period=breakfast\|lunch\|dinner` narrows it to a meal (that day's meal when combined with `scope=today`, any day's otherwise) |
| `GET` | `/api/stats` | Totals plus a per-station and per-meal breakdown, for the dashboard |
| `GET` | `/api/ratings/history` | Per-minute rating history for one dish (`?dish=`), one station (`?station=`) or one meal (`?period=`), plus every individual rating for a dish |
| `GET` | `/api/ratings/daily` | How many ratings were cast on each day, for the dashboard's volume histogram. Fills the quiet days with zero between the first and last rated day. `period=breakfast\|lunch\|dinner` and `category=<station or static section>` narrow it |

### Scopes and timezones

`/api/stats` and `/api/dishes` answer twice: all-time, and restricted to a single day. The day is not the UTC day. Callers pass `date=YYYY-MM-DD&offset=<getTimezoneOffset()>` — the dashboard sends its own calendar date and offset — because the hall is in Vermont, and at 8pm Eastern the UTC date has already rolled over. Without the offset, a rating cast over dinner would land on tomorrow's menu. Ratings are stamped with `Date.now()`, so a day is a half-open window over `updated_at`; the history endpoint buckets with the same offset.

"Today" filters two different things on purpose: the dish list comes from `dish_days` (what the menu served), while the counts come from the `updated_at` window (what people rated). A dish that is on today's menu but unrated today stays listed at zero rather than disappearing, and a dish rated today but not served today does not appear.

### Dashboard drill-downs

`/api/ratings/history` returns a `timeline` (each minute's own average plus the running average up to that minute) and, for a dish, the itemised `ratings`. The running average is the one the charts plot: a single minute's average swings wildly over two or three ratings, while the running figure is what a reader means by the number having moved.

Points are bucketed by **minute**, not by day. A dish rated three times over dinner would otherwise be a single dot, which hides the only shape there is to see. Each point carries:

| Field | Meaning |
| --- | --- |
| `minute` | `YYYY-MM-DDTHH:MM` in the caller's timezone — the axis label |
| `day` | The calendar day that minute belongs to, so a chart can tell a gap of minutes from a gap of days |
| `at` | The start of that minute, as epoch ms — the x position, so the point sits under its label |
| `rawAt` | The latest real instant in the bucket; a bucket labelled `12:01` can hold a rating cast at `12:01:47` |
| `count`, `average` | That minute's own ratings |
| `running`, `runningCount` | The average and count up to and including that minute |

The dashboard spaces points by `at`, not by index, so the line leans where rating was brisk and stretches where it was quiet; it marks each day boundary with a divider, because a long gap and a short one look alike on a line. The chart falls back to even spacing and day labels if `at` is absent, so it still renders against an older Worker.

Rater ids are truncated to an eight-character prefix in that response. A full `X-Rater-ID` is a write credential — the API trusts it without proof, so anyone holding one can post as that browser — and the dashboard only needs to show that two raters were different.

A dish is keyed by its normalised name (`"  Scrambled   Eggs "` → `"scrambled eggs"`), so it keeps one rating history across every day it is served. Ratings are counted from the rows on each read, so a number shown is always current rather than a nightly roll-up. Re-rating replaces your previous rating; `DELETE` clears it and returns the dish to the community aggregate, or to "No ratings yet" if you were the last rater. It only ever removes the caller's own row, and it does not refund the daily write cap. `X-Rater-ID` is a random per-browser id, and writes are capped per rater per day.

### Deploying it

```bash
cd worker
npm install
npx wrangler d1 create hilltoppers-menu-ratings   # put the id in wrangler.toml
npx wrangler d1 execute hilltoppers-menu-ratings --config wrangler.toml --file=schema.sql --remote
npm run deploy
```

Then set `RATINGS_API` in `index.html` to the deployed Worker URL.

The `dish_stations` table was added after the first deploy, and `dish_periods` after that. This Worker has no migration step and `wrangler deploy` does not apply `schema.sql`, so each is created on demand on the first catalogue call (and by `/api/stats`), which heals a database created before the per-side and per-meal breakdowns existed. Applying `schema.sql` by hand is still the cleanest option for a new database.

A dish served on both stations counts toward both, so the per-station figures are a per-side view and can add up to more than the overall totals. The per-meal figures work the same way: a dish served at both lunch and dinner counts toward both.

Because the meals are recorded only when the widget catalogues a dish, the dashboard's meal filter fills in from the moment this deploys forward. Ratings and dishes catalogued before it have no meal, so they appear only under "All meals" — nothing is lost, but the per-meal counts start lower than the overall ones and catch up as the menu is re-catalogued.

The dashboard and the Worker deploy separately, and Pages usually finishes first. Until the Worker catches up, the dashboard detects the older API (the `scope` marker on the dish listing) and shows "Waiting for the ratings backend to publish today's data" rather than rendering the whole catalogue as if it were today's menu.

The minute-bucketed history needs a Worker deploy to take effect. Until then the dashboard falls back to even spacing and day labels, so the graphs still render — they just are not yet drawn against real time.

The meal filter has the same catch-up rule: an older Worker ignores `period=` and answers with the whole catalogue, and sends no per-meal blocks in `/api/stats`. The dashboard detects that (a missing `periods` array) and falls back to the overall figures for the cards and to "all meals" for the list, so nothing breaks while Pages is ahead of the Worker.

The volume histogram and the category filter need `/api/ratings/daily`, so they too wait on a Worker deploy. Until then the histogram shows its "No ratings in range yet." placeholder rather than an empty chart, and the category picker still lists the stations and static sections but the counts behind it stay flat.

## Embedding

Use an iframe with the following sandbox configuration:

```html
<iframe
  src="https://amos-donn.github.io/hilltoppers-menu/"
  sandbox="allow-scripts allow-same-origin allow-popups"
  style="width: 360px; height: 600px; border: none; border-radius: 8px;"
  title="Dining Menu"
></iframe>
```

**Sandbox permissions:**
- `allow-scripts` — JavaScript for tab switching, day navigation and ratings
- `allow-same-origin` — fetch `menu.json` from the same origin, and talk to the ratings API
- `allow-popups` — open dish and source links in new tabs

### Height modes (Hilltoppers Toppings)

The extension can embed this page with either a fixed height or "Fit content".
Fit content needs the page to report its own height, which `resize.js` does.

When the extension loads the page it appends `?session=<id>&host=<origin>` to the
URL and posts a `context` message naming the chosen mode. `resize.js` replies
with `{channel: 'hilltoppers-topping-v1', session, type: 'resize', height}`
whenever the content size changes, and only while the mode is `content`. It
ignores context messages whose origin or session do not match, and stays silent
when the page is opened directly rather than embedded.

The height is measured from the `[data-topping-content]` wrapper on `<main>`, so
it reflects real content rather than the iframe viewport. Keep that attribute on
whatever element wraps the whole page, including any footer, and do not give it
`height: 100vh`, `min-height: 100%`, or a fixed scrolling height — any of those
would stop the frame from shrinking. The extension clamps reports to 120–10,000px
and keeps the fixed layout until a valid one arrives.

## Menu Data Format

`menu.json` is generated; edit it only by hand as a stopgap. Structure:

```json
{
  "updatedAt": "ISO 8601 timestamp",
  "source": "menus.tenkites.com",
  "menuDate": "YYYY-MM-DD (today; kept for older clients)",
  "menus": { "breakfast": { ... }, "lunch": { ... }, "dinner": { ... } },
  "daysUpdatedAt": "ISO 8601 timestamp",
  "days": {
    "YYYY-MM-DD": {
      "breakfast": { "globalFare": ["Item 1"], "classicKitchen": ["Item 2"] },
      "lunch": { ... },
      "dinner": { ... }
    }
  }
}
```

**Notes:**
- Dates are `YYYY-MM-DD` and sorted ascending
- Items are trimmed and de-duplicated
- A missing or empty station shows "No item found" rather than breaking the layout

## Before this goes live

1. **Set the cron interval.** `.github/workflows/update-menu.yml` runs every 5 minutes. Shorten it if you want tighter latency; it is the single biggest lever on how fast a new menu reaches users.
2. **Keep the ratings Worker deployed.** `RATINGS_API` in `index.html` points at the deployed Worker (`https://hilltoppers-menu-ratings.amos-donn.workers.dev`). If that Worker is ever removed, clear `RATINGS_API` to fall back to per-browser ratings rather than leaving the widget pointing at a dead URL.
3. **Confirm Pages serves from the repository root (`/`).**

## Development

```bash
node --test scripts/          # menu fetch + parsing (fixtures are checked in)
cd worker && npm test         # ratings API against a real D1 database
cd worker && npm run typecheck
```

## Styling

The page uses the Hilltoppers extension color scheme:

- Primary green: `#1a7f37`
- Light panel: `#fbfcff`
- Text: `#161b22`
- Muted text: `#7d8591`
- Subtle borders: `rgba(17, 17, 17, 0.12)`

All styles are inlined in `index.html` for maximum portability.

## License

MIT — part of the Hilltoppers project.
