import { describe, it, expect } from "vitest";
import { itemIsValid, sanitize, parseBasket, buildUserMessage, countAllowed } from "./haul-ai-prompt.js";
import foods from "../../lookups/haul-foods.json";

const chicken = {
  name: "Chicken breast",
  section: "Protein",
  category: "protein",
  baseQtyG: 1000,
  per100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
  contains: [],
};
const rice = { name: "White rice", section: "Pantry", category: "carb", baseQtyG: 900, per100g: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 }, contains: [] };
const oil = { name: "Olive oil", section: "Pantry", category: "fat", baseQtyG: 250, per100g: { kcal: 884, protein: 0, carbs: 0, fat: 100 }, contains: [] };
const spinach = { name: "Spinach", section: "Produce", category: "veg", baseQtyG: 500, per100g: { kcal: 23, protein: 2.9, carbs: 3.6, fat: 0.4 }, contains: [] };
const apple = { name: "Apple", section: "Produce", category: "fruit", baseQtyG: 500, per100g: { kcal: 52, protein: 0.3, carbs: 14, fat: 0.2 }, contains: [] };

const okBasket = () => [chicken, rice, oil, spinach, apple,
  { ...rice, name: "Oats" }, { ...chicken, name: "Eggs" }, { ...spinach, name: "Broccoli" }];

describe("itemIsValid (Atwater guard)", () => {
  it("accepts a realistic item", () => {
    expect(itemIsValid(chicken)).toBe(true);
  });
  it("rejects hallucinated calories (kcal ≠ 4P+4C+9F)", () => {
    expect(itemIsValid({ ...chicken, per100g: { kcal: 500, protein: 31, carbs: 0, fat: 3.6 } })).toBe(false);
  });
  it("rejects an unknown section or category", () => {
    expect(itemIsValid({ ...chicken, section: "Deli" })).toBe(false);
    expect(itemIsValid({ ...chicken, category: "sugar" })).toBe(false);
  });
  it("rejects impossible energy density and non-numeric macros", () => {
    expect(itemIsValid({ ...oil, per100g: { kcal: 1200, protein: 0, carbs: 0, fat: 133 } })).toBe(false);
    expect(itemIsValid({ ...chicken, per100g: { kcal: 165, protein: "x", carbs: 0, fat: 3.6 } })).toBe(false);
  });
});

describe("sanitize", () => {
  it("keeps valid items and wraps them under the diet style", () => {
    const data = sanitize(okBasket(), "omnivore");
    expect(data).not.toBeNull();
    expect(Object.keys(data.diets)).toEqual(["omnivore"]);
    expect(data.diets.omnivore.length).toBe(8);
  });
  it("drops invalid items but keeps the rest", () => {
    const bad = { ...rice, name: "Fake", per100g: { kcal: 900, protein: 1, carbs: 1, fat: 1 } };
    const data = sanitize([...okBasket(), bad], "omnivore");
    expect(data.diets.omnivore.some((i) => i.name === "Fake")).toBe(false);
  });
  it("de-dupes by name (case-insensitive)", () => {
    const data = sanitize([...okBasket(), { ...chicken, name: "chicken breast" }], "omnivore");
    expect(data.diets.omnivore.filter((i) => i.name.toLowerCase() === "chicken breast").length).toBe(1);
  });
  it("returns null when a whole macro role is missing", () => {
    // No fat-category item → the engine couldn't hit fat, so reject.
    const noFat = okBasket().filter((i) => i.category !== "fat");
    expect(sanitize(noFat, "omnivore")).toBeNull();
  });
  it("returns null when too few items survive", () => {
    expect(sanitize([chicken, rice, oil], "omnivore")).toBeNull();
  });
  it("carries a count unit through when valid", () => {
    const eggs = { ...chicken, name: "Large eggs", unit: "count", perUnitG: 50 };
    const data = sanitize([...okBasket(), eggs], "omnivore");
    const kept = data.diets.omnivore.find((i) => i.name === "Large eggs");
    expect(kept.unit).toBe("count");
    expect(kept.perUnitG).toBe(50);
  });
});

describe("parseBasket", () => {
  it("extracts the JSON object even with surrounding prose", () => {
    const parsed = parseBasket('Here is your basket:\n{"items": [1, 2]}\nThanks!');
    expect(parsed).toEqual({ items: [1, 2] });
  });
  it("returns null on unparseable text", () => {
    expect(parseBasket("no json here")).toBeNull();
  });
});

describe("buildUserMessage", () => {
  it("includes targets, diet, and avoid list", () => {
    const msg = buildUserMessage({
      targets: { target: 2600, protein: 120, carbs: 330, fat: 75, goalLabel: "Fuel performance" },
      diet: { style: "vegan", avoid: ["nuts"], planDays: 7 },
    });
    expect(msg).toContain("2600 kcal");
    expect(msg).toContain("vegan");
    expect(msg).toContain("nuts");
  });
});

describe("count-unit guard", () => {
  it("allows genuinely countable items", () => {
    ["Eggs", "Banana", "Chicken breast", "Whole wheat bread", "Bell pepper (red)"].forEach((n) =>
      expect(countAllowed(n), n).toBe(true)
    );
  });
  it("blocks bulk weight/volume staples", () => {
    ["Olive oil", "Brown rice", "Oats", "Quinoa", "Lentils (dried)", "Greek yogurt (0% fat)",
     "Almonds", "Cottage cheese (low fat)", "Peanut butter"].forEach((n) =>
      expect(countAllowed(n), n).toBe(false)
    );
  });

  const eggsCount = { name: "Eggs", section: "Protein", category: "protein", baseQtyG: 300, per100g: { kcal: 155, protein: 13, carbs: 1.1, fat: 11 }, contains: ["eggs"], unit: "count", perUnitG: 50 };
  const oilCount = { name: "Olive oil", section: "Pantry", category: "fat", baseQtyG: 200, per100g: { kcal: 884, protein: 0, carbs: 0, fat: 100 }, contains: [], unit: "count", perUnitG: 15 };

  it("sanitize keeps count on a countable item", () => {
    const data = sanitize([...okBasket().filter((i) => i.name !== "Eggs"), eggsCount], "omnivore");
    const kept = data.diets.omnivore.find((i) => i.name === "Eggs");
    expect(kept.unit).toBe("count");
    expect(kept.perUnitG).toBe(50);
  });
  it("sanitize strips count from a bulk staple (olive oil) → weight", () => {
    const data = sanitize([...okBasket().filter((i) => i.name !== "Olive oil"), oilCount], "omnivore");
    const kept = data.diets.omnivore.find((i) => i.name === "Olive oil");
    expect(kept.unit).toBeUndefined();
    expect(kept.perUnitG).toBeUndefined();
  });
});

describe("packG (pack-size) pass-through", () => {
  it("carries a valid packG through sanitize", () => {
    const item = { ...chicken, name: "Chicken thigh", packG: 500 };
    const data = sanitize([...okBasket(), item], "omnivore");
    expect(data.diets.omnivore.find((i) => i.name === "Chicken thigh").packG).toBe(500);
  });
  it("drops an out-of-range packG", () => {
    const item = { ...chicken, name: "Silly pack", packG: 999999 };
    const data = sanitize([...okBasket(), item], "omnivore");
    expect(data.diets.omnivore.find((i) => i.name === "Silly pack").packG).toBeUndefined();
  });
});

describe("unitLabel (count-item noun) pass-through", () => {
  it("carries a unitLabel on a count item, singularized + lowercased", () => {
    const item = { ...chicken, name: "Chicken cutlet", unit: "count", perUnitG: 180, unitLabel: "Breasts" };
    const data = sanitize([...okBasket(), item], "omnivore");
    const kept = data.diets.omnivore.find((i) => i.name === "Chicken cutlet");
    expect(kept.unit).toBe("count");
    expect(kept.unitLabel).toBe("breast"); // "Breasts" → "breast"
  });
  it("leaves unitLabel undefined on a weight item", () => {
    const data = sanitize(okBasket(), "omnivore");
    expect(data.diets.omnivore.find((i) => i.name === "White rice").unitLabel).toBeUndefined();
  });
});

// The local food library and the AI output share one schema, so hold the seed
// data to the SAME guard the AI output passes through — this catches a bad seed
// item (wrong macros, bad section/category, a nonsensical count) at test time.
describe("local food library (lookups/haul-foods.json)", () => {
  const allItems = Object.values(foods.diets).flat();

  it("has items", () => {
    expect(allItems.length).toBeGreaterThan(20);
  });
  it("every item passes the shared itemIsValid guard", () => {
    const bad = allItems.filter((i) => !itemIsValid(i)).map((i) => i.name);
    expect(bad).toEqual([]);
  });
  it("no bulk staple is marked as a count unit", () => {
    const offenders = allItems
      .filter((i) => i.unit === "count" && !countAllowed(i.name))
      .map((i) => i.name);
    expect(offenders).toEqual([]);
  });
  it("every count item has a unitLabel noun (no bare-number display)", () => {
    const missing = allItems
      .filter((i) => i.unit === "count" && !i.unitLabel)
      .map((i) => i.name);
    expect(missing).toEqual([]);
  });
});
