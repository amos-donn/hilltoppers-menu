// Reads the SJA dining menu from the source site and writes menu.json.
//
// Run by .github/workflows/update-menu.yml on a short schedule, and by hand with:
//   node scripts/fetch-menu.mjs
//
// The source site has no JSON API. Each date has its own meal identifiers, so
// a date is read from its own page before its meals are fetched; asking for one
// date with another's identifiers silently returns the wrong meal.

import fs from "node:fs/promises";
import { load } from "cheerio";

const MENU_URL = "https://menus.tenkites.com/eliorna/d0358";
const OUT = "menu.json";

// Today is re-read on every run. The days after it change rarely and cost four
// requests each, so they are only re-read a few times a day.
const DAYS_AHEAD = 7;
const FUTURE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const MEALS = ["breakfast", "lunch", "dinner"];

// The source names a meal's stations differently depending on the period. The
// morning period posts under Jumpstart/Sweet Shop/Soupside rather than the
// Global Fare/Classic Kitchen used at lunch and dinner, so each widget station
// maps to whichever source sections hold that food.
export const STATION_SECTIONS = {
  globalFare: ["Global Fare", "Jumpstart"],
  classicKitchen: ["Classic Kitchen", "Sweet Shop", "Soupside"]
};

const norm = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");

const uniq = (values) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

async function fetchHtml(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

export function parseBaseMeta(html) {
  const date = html.match(/k10\.settings\.menu\.date\s*=\s*'([^']+)'/)?.[1];
  const locationGuid = html.match(/k10\.settings\.menu\.location\.guid\s*=\s*'([^']+)'/)?.[1];
  if (!date || !locationGuid) {
    throw new Error("Cannot parse the menu date or location from the source page");
  }

  const $ = load(html);
  const mealIds = {};
  $(".k10-menu-selector__option").each((_, el) => {
    const name = norm($(el).text());
    const id = ($(el).attr("data-menu-identifier") || "").trim();
    if (name && id) mealIds[name] = id;
  });

  return { date, locationGuid, mealIds };
}

function buildMealUrl({ locationGuid, date, menuGuid }) {
  const url = new URL(MENU_URL);
  url.searchParams.set("cl", "true");
  url.searchParams.set("mguid", locationGuid);
  url.searchParams.set("mldate", date);
  url.searchParams.set("mlguid", menuGuid);
  url.searchParams.set("internalrequest", "true");
  return url.toString();
}

export function buildDayUrl(date) {
  const url = new URL(MENU_URL);
  url.searchParams.set("mldate", date);
  return url.toString();
}

export function extractSectionItems(html, sectionName) {
  const $ = load(html);
  const target = norm(sectionName);
  const course = $(".k10-course.k10-course_level_1")
    .filter((_, el) => norm($(el).find(".k10-course__name_level_1").first().text()) === target)
    .first();

  if (course.length === 0) return [];
  return uniq(course.find(".k10-recipe__name").map((_, el) => $(el).text()).get());
}

export function extractStationItems(html, sections) {
  const seen = new Set();
  const items = [];
  for (const section of sections) {
    for (const item of extractSectionItems(html, section)) {
      if (seen.has(item)) continue;
      seen.add(item);
      items.push(item);
    }
  }
  return items;
}

function emptyMeals() {
  return {
    breakfast: { classicKitchen: [], globalFare: [] },
    lunch: { classicKitchen: [], globalFare: [] },
    dinner: { classicKitchen: [], globalFare: [] }
  };
}

function countItems(meals) {
  return MEALS.reduce(
    (total, meal) => total + meals[meal].classicKitchen.length + meals[meal].globalFare.length,
    0
  );
}

/** The meals for one date, or null when the source has nothing for it. */
async function fetchMealsForDate(date, locationGuid, knownMeta) {
  const meta = knownMeta ?? parseBaseMeta(await fetchHtml(buildDayUrl(date)));

  // Past the last planned day the site ignores mldate and serves today, which
  // would otherwise be filed under the future date as if it were real.
  if (meta.date !== date) return null;

  const meals = emptyMeals();
  for (const meal of MEALS) {
    const menuGuid = meta.mealIds[meal];
    if (!menuGuid) continue;
    const html = await fetchHtml(buildMealUrl({ locationGuid, date, menuGuid }));
    meals[meal] = {
      globalFare: extractStationItems(html, STATION_SECTIONS.globalFare),
      classicKitchen: extractStationItems(html, STATION_SECTIONS.classicKitchen)
    };
  }

  return countItems(meals) > 0 ? meals : null;
}

export function addDays(date, days) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUT, "utf8"));
  } catch {
    return null;
  }
}

export function buildPayload({ date, todayMeals, days, refreshFuture, daysUpdatedAt }) {
  const orderedDays = {};
  for (const key of Object.keys(days).sort()) orderedDays[key] = days[key];

  return {
    updatedAt: new Date().toISOString(),
    source: "menus.tenkites.com",
    // menuDate and menus describe today; older clients read only these two.
    menuDate: date,
    menus: todayMeals,
    daysUpdatedAt: refreshFuture ? new Date().toISOString() : daysUpdatedAt,
    days: orderedDays
  };
}

async function main() {
  const baseHtml = await fetchHtml(MENU_URL);
  const baseMeta = parseBaseMeta(baseHtml);
  const { date, locationGuid } = baseMeta;

  const existing = await readExisting();
  const previousDays =
    existing?.days && typeof existing.days === "object" ? existing.days : {};
  const futureAge = existing?.daysUpdatedAt
    ? Date.now() - Date.parse(existing.daysUpdatedAt)
    : Number.POSITIVE_INFINITY;
  const refreshFuture = !(futureAge < FUTURE_MAX_AGE_MS);

  const todayMeals = await fetchMealsForDate(date, locationGuid, baseMeta);
  if (!todayMeals) {
    // Never overwrite a good file with an empty read; a transient parse
    // failure would otherwise wipe the menu everyone is looking at.
    console.log("Nothing parsed for today. Leaving menu.json untouched.");
    return;
  }

  // Keep every day already known, then layer the freshly read ones on top, so
  // history is not dropped as the fetch window slides forward.
  const days = { ...previousDays, [date]: todayMeals };
  for (let offset = 1; offset <= DAYS_AHEAD; offset += 1) {
    if (!refreshFuture) continue;
    const target = addDays(date, offset);
    const meals = await fetchMealsForDate(target, locationGuid);
    if (meals) days[target] = meals;
  }

  // Only write when the menu itself changed, so an idle run makes no commit and
  // the widget can tell from updatedAt whether anything new actually arrived.
  if (JSON.stringify(days) === JSON.stringify(previousDays)) {
    console.log("Menu unchanged. Leaving menu.json untouched.");
    return;
  }

  const payload = buildPayload({
    date,
    todayMeals,
    days,
    refreshFuture,
    daysUpdatedAt: existing?.daysUpdatedAt
  });
  await fs.writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `menu.json updated (${Object.keys(payload.days).length} days, future ${
      refreshFuture ? "refreshed" : "carried over"
    })`
  );
}

// Only run when invoked directly, so the helpers stay importable for tests.
if (process.argv[1] && process.argv[1].endsWith("fetch-menu.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
