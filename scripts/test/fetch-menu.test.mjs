import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  addDays,
  buildDayUrl,
  buildPayload,
  extractSectionItems,
  extractStationItems,
  parseBaseMeta,
  STATION_SECTIONS
} from "../fetch-menu.mjs";

const fixture = (name) =>
  gunzipSync(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).toString("utf8");

const basePage = fixture("base-page.html.gz");
const mealPage = fixture("meal-page.html.gz");
const breakfastPage = fixture("breakfast-page.html.gz");

test("reads the date, location and meal identifiers from the source page", () => {
  const meta = parseBaseMeta(basePage);
  assert.match(meta.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(meta.locationGuid.length > 0);
  assert.deepEqual(Object.keys(meta.mealIds).sort(), ["breakfast", "dinner", "lunch"]);
  for (const id of Object.values(meta.mealIds)) assert.ok(id.length > 0);
});

test("fails loudly when the page is not the menu page", () => {
  assert.throws(() => parseBaseMeta("<html><body>nope</body></html>"), /Cannot parse/);
});

test("extracts a section by name, trimmed, de-duplicated and in page order", () => {
  const globalFare = extractSectionItems(mealPage, "Global Fare");
  assert.ok(globalFare.length > 0);
  assert.ok(globalFare.every((item) => item === item.trim()));
  assert.equal(new Set(globalFare).size, globalFare.length, "no duplicates");
  assert.ok(globalFare.every((item) => !/\n|\t/.test(item)), "no stray whitespace");
});

test("section matching ignores case and extra spacing", () => {
  assert.deepEqual(
    extractSectionItems(mealPage, "  global   fare "),
    extractSectionItems(mealPage, "Global Fare")
  );
});

test("an absent section yields an empty list rather than throwing", () => {
  assert.deepEqual(extractSectionItems(mealPage, "No Such Station"), []);
});

test("the two stations do not bleed into each other", () => {
  const globalFare = extractSectionItems(mealPage, "Global Fare");
  const classicKitchen = extractSectionItems(mealPage, "Classic Kitchen");
  assert.ok(classicKitchen.length > 0);
  for (const item of classicKitchen) {
    assert.ok(!globalFare.includes(item), `${item} appears in both stations`);
  }
});

test("the morning period reads its own station names", () => {
  // The source posts the morning meal under Jumpstart/Sweet Shop/Soupside
  // rather than the Global Fare/Classic Kitchen used later in the day. Reading
  // those sections is what stops breakfast from silently coming back empty.
  const globalFare = extractStationItems(breakfastPage, STATION_SECTIONS.globalFare);
  const classicKitchen = extractStationItems(breakfastPage, STATION_SECTIONS.classicKitchen);
  assert.ok(globalFare.length > 0, "morning Global Fare is populated");
  assert.ok(classicKitchen.length > 0, "morning Classic Kitchen is populated");
  assert.equal(new Set(globalFare).size, globalFare.length, "no duplicates in Global Fare");
  assert.equal(new Set(classicKitchen).size, classicKitchen.length, "no duplicates in Classic Kitchen");
});

test("the station mapping folds the morning sections in without dropping the usual ones", () => {
  assert.ok(STATION_SECTIONS.globalFare.includes("Global Fare"));
  assert.ok(STATION_SECTIONS.globalFare.includes("Jumpstart"));
  assert.ok(STATION_SECTIONS.classicKitchen.includes("Classic Kitchen"));

  // The lunch/dinner page has Global Fare and Classic Kitchen; folding in the
  // morning names must not add or lose anything there.
  assert.deepEqual(
    extractStationItems(mealPage, STATION_SECTIONS.globalFare),
    extractSectionItems(mealPage, "Global Fare")
  );
  assert.deepEqual(
    extractStationItems(mealPage, STATION_SECTIONS.classicKitchen),
    extractSectionItems(mealPage, "Classic Kitchen")
  );
});

test("a section listed twice is merged without repeating a dish", () => {
  const merged = extractStationItems(breakfastPage, ["Jumpstart", "Jumpstart", "No Such Station"]);
  assert.deepEqual(merged, extractStationItems(breakfastPage, ["Jumpstart"]));
});

test("day urls carry the requested date", () => {
  const url = new URL(buildDayUrl("2026-09-25"));
  assert.equal(url.searchParams.get("mldate"), "2026-09-25");
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-09-28", 7), "2026-10-05");
  assert.equal(addDays("2026-12-29", 7), "2027-01-05");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("the payload keeps older clients working and sorts the days", () => {
  const days = {
    "2026-10-01": { breakfast: { classicKitchen: [], globalFare: [] } },
    "2026-09-25": { breakfast: { classicKitchen: ["Eggs"], globalFare: [] } }
  };
  const payload = buildPayload({
    date: "2026-09-25",
    todayMeals: days["2026-09-25"],
    days,
    refreshFuture: true,
    daysUpdatedAt: "old"
  });

  assert.deepEqual(Object.keys(payload.days), ["2026-09-25", "2026-10-01"]);
  assert.equal(payload.menuDate, "2026-09-25");
  assert.equal(payload.menus, days["2026-09-25"]);
  assert.equal(payload.source, "menus.tenkites.com");
  assert.ok(!Number.isNaN(Date.parse(payload.updatedAt)));
  assert.ok(!Number.isNaN(Date.parse(payload.daysUpdatedAt)));
});

test("daysUpdatedAt is carried over when the future days were not refreshed", () => {
  const payload = buildPayload({
    date: "2026-09-25",
    todayMeals: { breakfast: { classicKitchen: [], globalFare: [] } },
    days: {},
    refreshFuture: false,
    daysUpdatedAt: "2026-09-25T00:00:00.000Z"
  });
  assert.equal(payload.daysUpdatedAt, "2026-09-25T00:00:00.000Z");
});
