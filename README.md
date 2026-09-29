# Hilltoppers Menu

Standalone menu page for Saint Johnsbury Academy dining — designed for GitHub Pages hosting and iframe embedding.

## Live

**GitHub Pages:** https://amos-donn.github.io/hilltoppers-menu/

## Features

- **Three dining periods:** Breakfast, Lunch, Dinner
- **Two kitchen stations:** Global Fare, Classic Kitchen — always side by side, including in a narrow iframe
- **Always visible:** no dropdown or collapse control; the widget renders its content directly
- **Day navigation:** step through published menu dates with the arrows next to the Menu Website link
- **Source links:** every dish links to the day it is served on, on the original dining site
- **Star ratings:** each dish shows its average rating under its title as read-only stars; the rating row is a button that opens a dialog to rate it
- **Confirm-before-save:** the dialog previews a value as you hover or focus a star, keeps Save disabled until you pick one, and lets Cancel, Escape, or an outside click discard without saving
- **Shared ratings:** once the Worker URL is set, ratings are shared between everyone rather than stored per browser
- **Ratings dashboard:** `dashboard.html` shows overall totals, a per-side breakdown (average rating, number of ratings, and rater IDs for Global Fare and Classic Kitchen), and every rated dish split into "Ranked" (3+ ratings) and "Still gathering ratings"
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
  schema.sql          tables: dishes, dish_days, dish_stations, dish_ratings, rater_writes
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
| `POST` | `/api/dishes/catalog` | Record the dishes served on a day; body `{ "date": "...", "dishes": [...] }`, optionally grouped by station as `"stations": { "Global Fare": [...], "Classic Kitchen": [...] }` |
| `GET` | `/api/dishes` | The whole catalogue with ratings, for inspection |
| `GET` | `/api/stats` | Totals plus a per-station breakdown, for the dashboard |

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

The `dish_stations` table was added after the first deploy. This Worker has no migration step and `wrangler deploy` does not apply `schema.sql`, so the table is created on demand on the first catalogue call (and by `/api/stats`), which heals a database created before the per-side breakdown existed. Applying `schema.sql` by hand is still the cleanest option for a new database.

A dish served on both stations counts toward both, so the per-station figures are a per-side view and can add up to more than the overall totals.

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
