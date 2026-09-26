# Hilltoppers Menu

Standalone menu page for Saint Johnsbury Academy dining — designed for GitHub Pages hosting and iframe embedding.

## Live

**GitHub Pages:** https://amos-donn.github.io/hilltoppers-menu/

## Features

- **Three dining periods:** Breakfast, Lunch, Dinner
- **Two kitchen stations:** Global Fare, Classic Kitchen
- **Day navigation:** Browse published menu dates with arrow buttons
- **Iframe-safe:** All styles inline, no external dependencies
- **Mobile responsive:** Works on any screen size
- **Google dish search:** Click any item to search for it

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
- `allow-scripts` — JavaScript for tab switching, date navigation
- `allow-same-origin` — fetch `menu.json` from the same origin
- `allow-popups` — open Google search links in new tabs

## Menu Data Format

Edit `menu.json` to update the menu. Structure:

```json
{
  "updatedAt": "ISO 8601 timestamp (optional)",
  "source": "URL to campus dining website (optional)",
  "days": {
    "YYYY-MM-DD": {
      "breakfast": {
        "globalFare": ["Item 1", "Item 2"],
        "classicKitchen": ["Item 1", "Item 2"]
      },
      "lunch": { ... },
      "dinner": { ... }
    }
  }
}
```

**Notes:**
- Dates must be in `YYYY-MM-DD` format and sorted ascending
- Items are automatically deduplicated and trimmed
- Missing items show "No items" gracefully

## Updating the Menu

1. Edit `menu.json` directly in GitHub
2. Commit to `main`
3. GitHub Pages rebuilds automatically (within 1 minute)

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
