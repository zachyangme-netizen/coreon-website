import { describe, it, expect } from "vitest";
import { itemIsValid, sanitize, parseBasket, buildUserMessage } from "./haul-ai-prompt.js";

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
