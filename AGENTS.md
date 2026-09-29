# Repository notes for agents

Operational context that is not obvious from the code. See `README.md` for the
product and API docs.

## Layout

- `index.html` — the menu widget **and** the ratings dashboard: one page, two columns, with the widget on the left and the dashboard on the right. It is what GitHub Pages serves at the site root. Must stay iframe-safe — embedded in the extension it collapses to the widget alone (see *One page, two shapes* in `README.md`).
- `dashboard.html` — a redirect to the site root. The dashboard is now the right-hand column of `index.html`; this page only exists so an old bookmark or link still lands somewhere.
- `menu.json` — **generated**. Do not hand-edit. Produced by `.github/workflows/update-menu.yml` from the source dining site and changes several times a day.
- `worker/` — Cloudflare Worker + D1 ratings backend (see `README.md`)

## Never regress `menu.json`

It is regenerated on a schedule and moves several times a day. A branch built on
an older `menu.json` will revert the live menu to stale data on merge — the exact
problem this project exists to avoid. Before merging anything, confirm the branch
does not touch it:

```bash
git diff origin/main -- menu.json | wc -l   # must print 0
```

If a conflict ever involves `menu.json`, take `origin/main`'s version.

## Pushing and credentials

- Use `GITHUB_TOKEN` (platform-managed). Other token-like secrets in the
  environment are expired and ignored.
- The git remote has **no** token embedded. Push non-interactively by setting the
  URL for the command only, then restore it, and always disable the prompt —
  otherwise a failed auth hangs the shell on a username prompt:

```bash
git remote set-url origin "https://${GITHUB_TOKEN}@github.com/amos-donn/hilltoppers-menu.git"
GIT_TERMINAL_PROMPT=0 git push -u origin <branch>
git remote set-url origin "https://github.com/amos-donn/hilltoppers-menu.git"
```

- Never echo, print, or commit the token. The Worker needs no secrets.

## The Worker does not deploy with the PR

`wrangler deploy` is not part of the Pages workflow, and there are no Cloudflare
credentials in the dev environment. Merging a Worker change does **not** put it
live — the Worker must be deployed separately. GitHub Pages (the dashboard and
widget) does deploy on merge to `main`.

Because of this, the dashboard and the API can be out of step. The dashboard
detects an API that predates a field and degrades rather than showing wrong data
(see the `scope` marker on `/api/dishes`). Keep that property when adding fields.

## Tests

```bash
cd scripts && node --test        # menu parsing/serving
cd ../worker && npx vitest run   # API, against a real D1 via Miniflare
```

Miniflare accepts some SQL that the live D1 rejects, so a green suite is not proof
the queries work in production. When changing SQL, also exercise the deployed
Worker directly before trusting it.

The browser suites stub the API. A stub that ignores the request (query string,
body) will pass while the real call is malformed — that is how a dish drill-down
shipped sending an empty `dish=` and 400ing on the live site while the suite was
green. Make stubs validate what the real endpoint validates, and assert on the
parameters the code actually sends. Before trusting a green suite, drive the
deployed site once.

## Ratings data

- The API has **no authentication**. Anyone with the URL can read and write
  ratings, and `X-Rater-ID` is a random per-browser value that could be forged.
  There is a per-rater daily write cap. Fine for a dining-hall widget; do not
  reuse this Worker for anything sensitive, and do not present it as secure.
- A full `X-Rater-ID` is effectively a write credential. Do not expose it in a
  read endpoint; the dashboard shows an eight-character prefix.
- "Today" means the caller's local day, not the UTC day (the hall is in Vermont).
  Callers pass their own date and UTC offset.
- The live D1 may hold test ratings from previous verification runs. Clean up
  after testing so the school starts fresh.
