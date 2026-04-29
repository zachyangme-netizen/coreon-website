// Coreon Haul — wizard state, hash routing, step logic.
// v5: M1 ships. Goal + Stats + Training + Diet collected. Result shows
//     the calorie + macro target reveal (no AI). M2 (full haul) coming next.

const STEPS = ["goal", "stats", "training", "diet", "result"];

const STEP_META = {
  goal:     { label: "Step 1 of 5 · Goal",     progress: 20 },
  stats:    { label: "Step 2 of 5 · Stats",    progress: 40 },
  training: { label: "Step 3 of 5 · Training", progress: 60 },
  diet:     { label: "Step 4 of 5 · Diet",     progress: 80 },
  result:   { label: "Your haul",              progress: 100 },
};

const GOAL_LABELS = {
  "lose-fat":         "Lose fat",
  "gain-muscle":      "Gain muscle",
  "fuel-performance": "Fuel performance",
};

const STORAGE_KEY = "coreon-haul-state";

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveState(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage can throw in private mode — fail silently.
  }
}

const state = loadState();
state.stats    = state.stats    || { units: "imperial" };
state.training = state.training || {};
state.diet     = state.diet     || {};
if (!state.stats.units) state.stats.units = "imperial";
// `state.training.mode` is no longer stored — it's derived from activityLevel
// at compute time. Clean up any value left over from earlier builds.
if (state.training.mode) delete state.training.mode;
if (!Array.isArray(state.diet.avoid)) state.diet.avoid = [];
if (state.diet.planDays == null)      state.diet.planDays = 7;
if (!state.diet.cookTime)             state.diet.cookTime = "any";
if (state.diet.avoidOther == null)    state.diet.avoidOther = "";
if (state.diet.notes == null)         state.diet.notes = "";

// ─────────────────────────────────────────────
// Unit conversion
// canonical: heightCm, weightKg, weeklyKm
// ─────────────────────────────────────────────

function cmToFtIn(cm) {
  const totalIn = cm / 2.54;
  let ft = Math.floor(totalIn / 12);
  let inches = Math.round(totalIn - ft * 12);
  if (inches === 12) { ft += 1; inches = 0; }
  return { ft, in: inches };
}

function ftInToCm(ft, inches) {
  return (ft * 12 + inches) * 2.54;
}

function kgToLb(kg) {
  return Math.round(kg * 2.20462 * 10) / 10;
}

function lbToKg(lb) {
  return lb / 2.20462;
}

function miToKm(mi) {
  return mi * 1.609344;
}

function kmToMi(km) {
  return Math.round(km / 1.609344 * 10) / 10;
}

// ─────────────────────────────────────────────
// M1 — Calorie + macro engine (deterministic, no AI)
// ─────────────────────────────────────────────

const ACTIVITY_FACTOR = 1.036;   // kcal per kg per km of running
const NEAT_FACTOR     = 0.35;    // non-exercise activity ≈ 35% of BMR
const FAT_PCT         = 0.25;    // 25% of calories from fat
const MAX_DEFICIT     = 500;     // safety cap for fat-loss target

const GOAL_INFO = {
  "lose-fat":         { factor: 0.85, capDeficit: true,  proteinPerKg: 1.8 },
  "gain-muscle":      { factor: 1.10, capDeficit: false, proteinPerKg: 1.8 },
  "fuel-performance": { factor: 1.00, capDeficit: false, proteinPerKg: 1.6 },
};

// For non-runner mode: standard Mifflin activity multipliers (slightly rounded).
const ACTIVITY_MULTIPLIERS = {
  light:    1.4,   // 1–3 days/week light-to-moderate exercise
  moderate: 1.6,   // 4–5 days/week
  high:     1.8,   // 6+ days/week or hard daily training
};

function computeBMR({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "male" ? base + 5 : base - 161;
}

function computeTargets() {
  const goal = state.goal;
  const { sex, weightKg, heightCm, age } = state.stats;
  const training = state.training;
  // Mode is derived: if the user picked an activity level, treat them as a
  // non-runner (mileage skipped). Otherwise it's the runner path.
  const mode = training.activityLevel ? "non-runner" : "runner";

  const bmr = computeBMR({ sex, weightKg, heightCm, age });

  let tdee, runningPerDay = 0, neat = 0, activityMultiplier = null;

  if (mode === "non-runner") {
    activityMultiplier = ACTIVITY_MULTIPLIERS[training.activityLevel] || 1.4;
    tdee = bmr * activityMultiplier;
  } else {
    runningPerDay = (weightKg * ACTIVITY_FACTOR * training.weeklyKm) / 7;
    neat = bmr * NEAT_FACTOR;
    tdee = bmr + neat + runningPerDay;
  }

  const info = GOAL_INFO[goal];
  let target = tdee * info.factor;

  // Cap deficit to protect performance (fat-loss only)
  if (info.capDeficit && tdee - target > MAX_DEFICIT) {
    target = tdee - MAX_DEFICIT;
  }

  const proteinG    = Math.round(weightKg * info.proteinPerKg);
  const proteinKcal = proteinG * 4;
  const fatKcal     = target * FAT_PCT;
  const fatG        = Math.round(fatKcal / 9);
  const carbsKcal   = target - proteinKcal - fatKcal;
  const carbsG      = Math.round(carbsKcal / 4);

  return {
    goal,
    goalLabel: GOAL_LABELS[goal] || goal,
    mode,
    bmr:        Math.round(bmr),
    runningPerDay: Math.round(runningPerDay),
    neat:       Math.round(neat),
    activityMultiplier,
    activityLevel: training.activityLevel || null,
    tdee:       Math.round(tdee),
    target:     Math.round(target),
    adjKcal:    Math.round(target - tdee),
    protein:    proteinG,
    carbs:      carbsG,
    fat:        fatG,
    proteinPerKg: info.proteinPerKg,
  };
}

// ─────────────────────────────────────────────
// Step routing
// ─────────────────────────────────────────────

const stepLabel    = document.getElementById("step-label");
const stepProgress = document.getElementById("step-progress");

function getStepFromHash() {
  const hash = (window.location.hash || "").replace(/^#/, "");
  if (STEPS.includes(hash)) return hash;

  // No explicit hash — returning users with valid inputs land on the result.
  if (isResultReady()) return "result";
  return "goal";
}

function showStep(step) {
  document.querySelectorAll(".haul-step").forEach((el) => {
    el.hidden = el.dataset.step !== step;
  });

  const meta = STEP_META[step] || STEP_META.goal;
  stepLabel.textContent = meta.label;
  stepProgress.style.width = `${meta.progress}%`;

  // Move keyboard focus to the visible step's heading.
  const visible = document.querySelector(`.haul-step[data-step="${step}"]`);
  const heading = visible?.querySelector("h1, h2");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }

  window.scrollTo({ top: 0, behavior: "smooth" });

  // Refresh derived UI when entering a step.
  if (step === "stats") {
    updateStatsGoalSummary();
  } else if (step === "training") {
    updateTrainingGoalSummary();
    renderTrainingForm();
    updateTrainingContinue();
  } else if (step === "diet") {
    updateDietGoalSummary();
    renderDietForm();
    updateDietContinue();
  } else if (step === "result") {
    renderResult();
  }
}

function isResultReady() {
  return !!state.goal
      && validateStats(state.stats)
      && validateTraining(state.training);
}

window.addEventListener("hashchange", () => showStep(getStepFromHash()));

// ─────────────────────────────────────────────
// Step 1 — Goal
// ─────────────────────────────────────────────

const goalCards    = Array.from(document.querySelectorAll("[data-goal]"));
const goalContinue = document.getElementById("continue-btn");
const goalHelper   = document.getElementById("continue-helper");

function applyGoalSelection(goal) {
  goalCards.forEach((card) => {
    const isSelected = card.dataset.goal === goal;
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-checked", isSelected ? "true" : "false");
  });

  const hasGoal = !!goal;
  goalContinue.disabled = !hasGoal;
  goalContinue.setAttribute("aria-disabled", hasGoal ? "false" : "true");
  goalHelper.textContent = hasGoal
    ? `Goal: ${GOAL_LABELS[goal] || goal}`
    : "Pick a goal to continue.";
}

goalCards.forEach((card) => {
  card.addEventListener("click", () => {
    state.goal = card.dataset.goal;
    saveState(state);
    applyGoalSelection(state.goal);
    updateStatsGoalSummary();
    updateTrainingGoalSummary();
    updateDietGoalSummary();
  });

  card.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = goalCards.indexOf(card);
    const next =
      e.key === "ArrowRight"
        ? goalCards[(idx + 1) % goalCards.length]
        : goalCards[(idx - 1 + goalCards.length) % goalCards.length];
    next.focus();
    next.click();
  });
});

goalContinue.addEventListener("click", () => {
  if (!state.goal) return;
  window.location.hash = "#stats";
});

// ─────────────────────────────────────────────
// Step 2 — Stats
// ─────────────────────────────────────────────

const statsForm        = document.getElementById("stats-form");
const statsContinueBtn = document.getElementById("stats-continue-btn");
const statsHelper      = document.getElementById("stats-helper");
const statsGoalSummary = document.getElementById("stats-goal-summary");

const ageInput      = document.getElementById("stats-age");
const heightCmInput = document.getElementById("stats-height-cm");
const heightFtInput = document.getElementById("stats-height-ft");
const heightInInput = document.getElementById("stats-height-in");
const weightInput   = document.getElementById("stats-weight");
const goalWtInput   = document.getElementById("stats-goal-weight");

const sexOptions  = Array.from(document.querySelectorAll("[data-sex]"));
const unitOptions = Array.from(document.querySelectorAll("[data-units]"));

function updateStatsGoalSummary() {
  if (!statsGoalSummary) return;
  statsGoalSummary.textContent = state.goal
    ? GOAL_LABELS[state.goal] || state.goal
    : "Not set";
}

function applyUnitsDisplay() {
  const units = state.stats.units;

  // Toggle which height row is visible.
  document.querySelectorAll("[data-units-display]").forEach((el) => {
    el.hidden = el.dataset.unitsDisplay !== units;
  });

  // Update weight unit suffixes.
  document.querySelectorAll('[data-unit-of="weight"]').forEach((el) => {
    el.textContent = units === "imperial" ? "lb" : "kg";
  });

  // Update distance unit suffixes (training step).
  document.querySelectorAll('[data-unit-of="distance"]').forEach((el) => {
    el.textContent = units === "imperial" ? "mi" : "km";
  });

  // Update unit-toggle button selection state.
  unitOptions.forEach((btn) => {
    const active = btn.dataset.units === units;
    btn.classList.toggle("selected", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });

  // Sensible placeholders per unit system.
  if (units === "imperial") {
    weightInput.placeholder = "150";
    goalWtInput.placeholder = "143";
    if (mileageInput) mileageInput.placeholder = "25";
  } else {
    weightInput.placeholder = "68";
    goalWtInput.placeholder = "65";
    if (mileageInput) mileageInput.placeholder = "40";
  }
}

function applySexSelection() {
  sexOptions.forEach((btn) => {
    const active = btn.dataset.sex === state.stats.sex;
    btn.classList.toggle("selected", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function renderStatsForm() {
  const stats = state.stats;
  const units = stats.units;

  ageInput.value = stats.age != null ? String(stats.age) : "";

  if (stats.heightCm != null) {
    if (units === "metric") {
      heightCmInput.value = String(Math.round(stats.heightCm));
    } else {
      const { ft, in: inches } = cmToFtIn(stats.heightCm);
      heightFtInput.value = String(ft);
      heightInInput.value = String(inches);
    }
  } else {
    heightCmInput.value = "";
    heightFtInput.value = "";
    heightInInput.value = "";
  }

  if (stats.weightKg != null) {
    weightInput.value = units === "imperial"
      ? String(kgToLb(stats.weightKg))
      : String(Math.round(stats.weightKg * 10) / 10);
  } else {
    weightInput.value = "";
  }

  if (stats.goalWeightKg != null) {
    goalWtInput.value = units === "imperial"
      ? String(kgToLb(stats.goalWeightKg))
      : String(Math.round(stats.goalWeightKg * 10) / 10);
  } else {
    goalWtInput.value = "";
  }

  applySexSelection();
}

function readStatsForm() {
  const units = state.stats.units;

  const age = parseInt(ageInput.value, 10);

  let heightCm = null;
  if (units === "metric") {
    const cm = parseFloat(heightCmInput.value);
    if (!isNaN(cm)) heightCm = cm;
  } else {
    const ft = parseInt(heightFtInput.value, 10);
    const inches = parseInt(heightInInput.value, 10);
    if (!isNaN(ft)) {
      heightCm = ftInToCm(ft, isNaN(inches) ? 0 : inches);
    }
  }

  let weightKg = null;
  const w = parseFloat(weightInput.value);
  if (!isNaN(w)) weightKg = units === "imperial" ? lbToKg(w) : w;

  let goalWeightKg = null;
  const gw = parseFloat(goalWtInput.value);
  if (!isNaN(gw)) goalWeightKg = units === "imperial" ? lbToKg(gw) : gw;

  return {
    age: isNaN(age) ? null : age,
    sex: state.stats.sex || null,
    heightCm,
    weightKg,
    goalWeightKg,
  };
}

function validateStats(s) {
  if (!s.age || s.age < 13 || s.age > 100) return false;
  if (!s.sex) return false;
  if (!s.heightCm || s.heightCm < 120 || s.heightCm > 230) return false;
  if (!s.weightKg || s.weightKg < 30 || s.weightKg > 300) return false;
  if (s.goalWeightKg != null && (s.goalWeightKg < 30 || s.goalWeightKg > 300)) {
    return false;
  }
  return true;
}

function updateStatsContinue() {
  const inputs = readStatsForm();
  const valid = validateStats(inputs);
  statsContinueBtn.disabled = !valid;
  statsContinueBtn.setAttribute("aria-disabled", valid ? "false" : "true");
  statsHelper.textContent = valid
    ? "Looks good — continue when ready."
    : "Fill in your details to continue.";
}

function saveStatsFromForm() {
  const inputs = readStatsForm();
  state.stats = {
    units: state.stats.units,
    sex:   state.stats.sex,
    ...inputs,
  };
  saveState(state);
  updateStatsContinue();
}

unitOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (state.stats.units === btn.dataset.units) return;
    state.stats.units = btn.dataset.units;
    saveState(state);
    applyUnitsDisplay();
    renderStatsForm();
    renderTrainingForm();
    updateStatsContinue();
    updateTrainingContinue();
  });
});

sexOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.stats.sex = btn.dataset.sex;
    saveState(state);
    applySexSelection();
    updateStatsContinue();
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = sexOptions.indexOf(btn);
    const next =
      e.key === "ArrowRight"
        ? sexOptions[(idx + 1) % sexOptions.length]
        : sexOptions[(idx - 1 + sexOptions.length) % sexOptions.length];
    next.focus();
    next.click();
  });
});

[ageInput, heightCmInput, heightFtInput, heightInInput, weightInput, goalWtInput]
  .forEach((el) => {
    if (!el) return;
    el.addEventListener("input", saveStatsFromForm);
  });

statsContinueBtn.addEventListener("click", () => {
  const inputs = readStatsForm();
  if (!validateStats(inputs)) return;
  state.stats = { units: state.stats.units, sex: state.stats.sex, ...inputs };
  saveState(state);
  window.location.hash = "#training";
});

statsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!statsContinueBtn.disabled) statsContinueBtn.click();
});

// ─────────────────────────────────────────────
// Step 3 — Training
// ─────────────────────────────────────────────

const trainingForm        = document.getElementById("training-form");
const trainingContinueBtn = document.getElementById("training-continue-btn");
const trainingHelper      = document.getElementById("training-helper");
const trainingGoalSummary = document.getElementById("training-goal-summary");

const mileageInput    = document.getElementById("training-mileage");
const hardDaysOptions = Array.from(document.querySelectorAll("[data-hard-days]"));
const activityOptions = Array.from(document.querySelectorAll("[data-activity]"));

function updateTrainingGoalSummary() {
  if (!trainingGoalSummary) return;
  trainingGoalSummary.textContent = state.goal
    ? GOAL_LABELS[state.goal] || state.goal
    : "Not set";
}

function applyHardDaysSelection() {
  hardDaysOptions.forEach((btn) => {
    const active = parseInt(btn.dataset.hardDays, 10) === state.training.hardDays;
    btn.classList.toggle("selected", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function applyActivitySelection() {
  activityOptions.forEach((btn) => {
    const active = btn.dataset.activity === state.training.activityLevel;
    btn.classList.toggle("selected", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function renderTrainingForm() {
  // Runner fields
  const units = state.stats.units;
  const km = state.training.weeklyKm;
  if (km != null) {
    mileageInput.value = units === "imperial"
      ? String(kmToMi(km))
      : String(Math.round(km * 10) / 10);
  } else {
    mileageInput.value = "";
  }
  applyHardDaysSelection();

  // Non-runner alternative
  applyActivitySelection();
}

function readTrainingForm() {
  const units = state.stats.units;
  const v = parseFloat(mileageInput.value);

  let weeklyKm = null;
  if (!isNaN(v) && v >= 0) {
    weeklyKm = units === "imperial" ? miToKm(v) : v;
  }

  return {
    weeklyKm,
    hardDays: state.training.hardDays != null ? state.training.hardDays : null,
    activityLevel: state.training.activityLevel || null,
  };
}

function validateTraining(t) {
  // Non-runner path: an activity level is enough on its own.
  if (t.activityLevel) {
    return ["light", "moderate", "high"].includes(t.activityLevel);
  }
  // Runner path: mileage + hard days both required.
  if (t.weeklyKm == null || t.weeklyKm < 0 || t.weeklyKm > 480) return false;
  if (t.hardDays == null || t.hardDays < 0 || t.hardDays > 3) return false;
  return true;
}

function updateTrainingContinue() {
  if (!trainingContinueBtn) return;
  const inputs = readTrainingForm();
  const valid = validateTraining(inputs);
  trainingContinueBtn.disabled = !valid;
  trainingContinueBtn.setAttribute("aria-disabled", valid ? "false" : "true");
  trainingHelper.textContent = valid
    ? "Looks good — continue when ready."
    : "Fill in your mileage and hard days — or pick an activity level below.";
}

// Mileage / hard-days and activity-level are mutually exclusive paths.
// Filling one clears the other so the engine has an unambiguous mode.
function clearActivityLevel() {
  if (state.training.activityLevel) {
    state.training.activityLevel = null;
    applyActivitySelection();
  }
}

function clearRunnerFields() {
  let changed = false;
  if (state.training.weeklyKm != null) {
    state.training.weeklyKm = null;
    mileageInput.value = "";
    changed = true;
  }
  if (state.training.hardDays != null) {
    state.training.hardDays = null;
    applyHardDaysSelection();
    changed = true;
  }
  return changed;
}

function saveTrainingFromForm() {
  const inputs = readTrainingForm();
  state.training = { ...state.training, ...inputs };
  saveState(state);
  updateTrainingContinue();
}

mileageInput.addEventListener("input", () => {
  // Typing mileage means the runner path — drop any activity-level pick.
  clearActivityLevel();
  saveTrainingFromForm();
});

hardDaysOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.training.hardDays = parseInt(btn.dataset.hardDays, 10);
    clearActivityLevel();
    saveState(state);
    applyHardDaysSelection();
    updateTrainingContinue();
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = hardDaysOptions.indexOf(btn);
    const next =
      e.key === "ArrowRight"
        ? hardDaysOptions[(idx + 1) % hardDaysOptions.length]
        : hardDaysOptions[(idx - 1 + hardDaysOptions.length) % hardDaysOptions.length];
    next.focus();
    next.click();
  });
});

activityOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.training.activityLevel = btn.dataset.activity;
    clearRunnerFields();
    saveState(state);
    applyActivitySelection();
    updateTrainingContinue();
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = activityOptions.indexOf(btn);
    const next = e.key === "ArrowRight"
      ? activityOptions[(idx + 1) % activityOptions.length]
      : activityOptions[(idx - 1 + activityOptions.length) % activityOptions.length];
    next.focus();
    next.click();
  });
});

trainingContinueBtn.addEventListener("click", () => {
  const inputs = readTrainingForm();
  if (!validateTraining(inputs)) return;
  state.training = { ...state.training, ...inputs };
  saveState(state);
  window.location.hash = "#diet";
});

trainingForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!trainingContinueBtn.disabled) trainingContinueBtn.click();
});

// ─────────────────────────────────────────────
// Step 4 — Diet
// ─────────────────────────────────────────────

const dietForm        = document.getElementById("diet-form");
const dietContinueBtn = document.getElementById("diet-continue-btn");
const dietHelper      = document.getElementById("diet-helper");
const dietGoalSummary = document.getElementById("diet-goal-summary");

const dietStyleOptions = Array.from(document.querySelectorAll("[data-diet]"));
const avoidChips       = Array.from(document.querySelectorAll("[data-avoid]"));
const mealsOptions     = Array.from(document.querySelectorAll("[data-meals]"));
const planDaysOptions  = Array.from(document.querySelectorAll("[data-plan-days]"));
const cookTimeOptions  = Array.from(document.querySelectorAll("[data-cook-time]"));
const avoidOtherInput  = document.getElementById("diet-avoid-other");
const notesInput       = document.getElementById("diet-notes");

function updateDietGoalSummary() {
  if (!dietGoalSummary) return;
  dietGoalSummary.textContent = state.goal
    ? GOAL_LABELS[state.goal] || state.goal
    : "Not set";
}

function applySingleSelect(options, attr, value) {
  options.forEach((btn) => {
    const isActive = btn.dataset[attr] === value || btn.dataset[attr] === String(value);
    btn.classList.toggle("selected", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
}

function applyChipSelection() {
  avoidChips.forEach((btn) => {
    const isActive = state.diet.avoid.includes(btn.dataset.avoid);
    btn.classList.toggle("selected", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function renderDietForm() {
  applySingleSelect(dietStyleOptions, "diet",     state.diet.style || null);
  applySingleSelect(mealsOptions,     "meals",    state.diet.mealsPerDay || null);
  applySingleSelect(planDaysOptions,  "planDays", state.diet.planDays);
  applySingleSelect(cookTimeOptions,  "cookTime", state.diet.cookTime);
  applyChipSelection();
  avoidOtherInput.value = state.diet.avoidOther || "";
  notesInput.value      = state.diet.notes || "";
}

function validateDiet(d) {
  if (!d.style) return false;
  if (!d.mealsPerDay) return false;
  return true;
}

function updateDietContinue() {
  if (!dietContinueBtn) return;
  const valid = validateDiet(state.diet);
  dietContinueBtn.disabled = !valid;
  dietContinueBtn.setAttribute("aria-disabled", valid ? "false" : "true");
  dietHelper.textContent = valid
    ? "Looks good — generate your haul."
    : "Pick your diet style and meal setup to continue.";
}

// Wire diet style segmented
dietStyleOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.diet.style = btn.dataset.diet;
    saveState(state);
    applySingleSelect(dietStyleOptions, "diet", state.diet.style);
    updateDietContinue();
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = dietStyleOptions.indexOf(btn);
    const next = e.key === "ArrowRight"
      ? dietStyleOptions[(idx + 1) % dietStyleOptions.length]
      : dietStyleOptions[(idx - 1 + dietStyleOptions.length) % dietStyleOptions.length];
    next.focus();
    next.click();
  });
});

// Wire avoid chips (multi-select toggle)
avoidChips.forEach((btn) => {
  btn.addEventListener("click", () => {
    const item = btn.dataset.avoid;
    const idx  = state.diet.avoid.indexOf(item);
    if (idx >= 0) state.diet.avoid.splice(idx, 1);
    else state.diet.avoid.push(item);
    saveState(state);
    applyChipSelection();
  });
});

// Wire meals per day segmented
mealsOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.diet.mealsPerDay = btn.dataset.meals;
    saveState(state);
    applySingleSelect(mealsOptions, "meals", state.diet.mealsPerDay);
    updateDietContinue();
  });
});

// Wire plan length segmented (note: dataset.planDays — already string)
planDaysOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.diet.planDays = parseInt(btn.dataset.planDays, 10);
    saveState(state);
    applySingleSelect(planDaysOptions, "planDays", state.diet.planDays);
  });
});

// Wire cook time segmented
cookTimeOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.diet.cookTime = btn.dataset.cookTime;
    saveState(state);
    applySingleSelect(cookTimeOptions, "cookTime", state.diet.cookTime);
  });
});

// Free-text fields
avoidOtherInput.addEventListener("input", () => {
  state.diet.avoidOther = avoidOtherInput.value;
  saveState(state);
});

notesInput.addEventListener("input", () => {
  state.diet.notes = notesInput.value;
  saveState(state);
});

dietContinueBtn.addEventListener("click", () => {
  if (!validateDiet(state.diet)) return;
  saveState(state);
  // For M1 we need goal + stats + training to compute targets. If somehow
  // any of those are missing (direct navigation), bounce to that step.
  if (!state.goal)                       { window.location.hash = "#goal";     return; }
  if (!validateStats(state.stats))       { window.location.hash = "#stats";    return; }
  if (!validateTraining(state.training)) { window.location.hash = "#training"; return; }
  window.location.hash = "#result";
});

dietForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!dietContinueBtn.disabled) dietContinueBtn.click();
});

// ─────────────────────────────────────────────
// Step 5 — Result (M1: targets reveal)
// ─────────────────────────────────────────────

const resultGoalLabel    = document.getElementById("result-goal-label");
const resultCalories     = document.getElementById("result-calories");
const resultProtein      = document.getElementById("result-protein");
const resultCarbs        = document.getElementById("result-carbs");
const resultFat          = document.getElementById("result-fat");
const resultWhy          = document.getElementById("result-why-text");
const resultBmr          = document.getElementById("result-bmr");
const resultRunning      = document.getElementById("result-running");
const resultNeat         = document.getElementById("result-neat");
const resultActivityLbl  = document.getElementById("result-activity-label");
const resultActivityMult = document.getElementById("result-activity-mult");
const resultTdee         = document.getElementById("result-tdee");
const resultGoalAdj      = document.getElementById("result-goal-adj");
const resultTarget       = document.getElementById("result-target");

function formatKcal(n) {
  return n.toLocaleString("en-US") + " kcal";
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function generateWhyText(t) {
  let context;

  if (t.mode === "non-runner") {
    const label = t.activityLevel || "moderate";
    context = `Built around a ${label} activity level.`;
  } else {
    const units = state.stats.units;
    const km    = state.training.weeklyKm;
    const hd    = state.training.hardDays;

    const distance = units === "imperial"
      ? `${kmToMi(km)}-mi`
      : `${Math.round(km)}-km`;

    const hardText = hd === 0 ? "no hard days"
                   : hd === 1 ? "1 hard day"
                   : hd === 2 ? "2 hard days"
                   : "3+ hard days";

    context = `Built around your ${distance} week with ${hardText}.`;
  }

  const intent = {
    "lose-fat":         "We're targeting a moderate deficit so the scale moves without sabotaging your training. Protein stays elevated to protect the muscle you've built.",
    "gain-muscle":      "A controlled surplus to support strength gains, with protein high enough that your body actually uses it.",
    "fuel-performance": "No deficit, no surplus — calories matched to how hard you're moving so you can train, recover, and adapt.",
  }[t.goal] || "";

  return `${context} ${intent}`;
}

function goalAdjustmentText(t) {
  if (t.adjKcal === 0) return "no change";
  const sign = t.adjKcal > 0 ? "+" : "−";
  return `${sign}${formatNumber(Math.abs(t.adjKcal))} kcal`;
}

function renderResult() {
  // Defensive: bounce back to the first incomplete step.
  if (!state.goal)                       { window.location.hash = "#goal";     return; }
  if (!validateStats(state.stats))       { window.location.hash = "#stats";    return; }
  if (!validateTraining(state.training)) { window.location.hash = "#training"; return; }

  const t = computeTargets();

  resultGoalLabel.textContent = t.goalLabel;
  resultCalories.textContent  = formatNumber(t.target);
  resultProtein.textContent   = formatNumber(t.protein);
  resultCarbs.textContent     = formatNumber(t.carbs);
  resultFat.textContent       = formatNumber(t.fat);

  resultWhy.textContent = generateWhyText(t);

  // Toggle which breakdown rows are shown based on training mode.
  document.querySelectorAll("[data-mode-row]").forEach((el) => {
    el.hidden = el.dataset.modeRow !== t.mode;
  });

  resultBmr.textContent = formatKcal(t.bmr);

  if (t.mode === "non-runner") {
    if (resultActivityLbl)  resultActivityLbl.textContent  = t.activityLevel || "moderate";
    if (resultActivityMult) resultActivityMult.textContent = `× ${t.activityMultiplier.toFixed(1)}`;
  } else {
    resultRunning.textContent = formatKcal(t.runningPerDay);
    resultNeat.textContent    = formatKcal(t.neat);
  }

  resultTdee.textContent    = formatKcal(t.tdee);
  resultGoalAdj.textContent = goalAdjustmentText(t);
  resultTarget.textContent  = formatKcal(t.target);
}

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────

applyGoalSelection(state.goal || null);
applyUnitsDisplay();
renderStatsForm();
renderTrainingForm();
renderDietForm();
updateStatsGoalSummary();
updateTrainingGoalSummary();
updateDietGoalSummary();
updateStatsContinue();
updateTrainingContinue();
updateDietContinue();
showStep(getStepFromHash());
