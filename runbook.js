// Coreon Runbook — wizard state, hash-based step routing, deterministic plan engine.
// v1: Goal + Current state + Schedule collected. Result is a placeholder until the
//     plan generator lands next. Engine version tag flows through saved state so
//     mid-cycle plan stability is preserved (see ARCHITECTURE_SPEC.md §2).

import "/src/auth/auth-ui.js";
import { pushRemote, pullRemoteIfSignedIn } from "/src/lib/prefs.js";

const STEPS = ["goal", "state", "schedule", "result"];

const STEP_META = {
  goal:     { label: "Step 1 of 4 · Goal",     progress: 25 },
  state:    { label: "Step 2 of 4 · Current",  progress: 50 },
  schedule: { label: "Step 3 of 4 · Schedule", progress: 75 },
  result:   { label: "Your runbook",           progress: 100 },
};

const GOAL_LABELS = {
  "5k":            "5K",
  "10k":           "10K",
  "half-marathon": "Half marathon",
  "marathon":      "Marathon",
  "base":          "Base fitness",
};

const STORAGE_KEY    = "coreon-runbook-state";
const ENGINE_VERSION = "runbook-v1.0";

const DAYS_OF_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS   = { mon: "MON", tue: "TUE", wed: "WED", thu: "THU", fri: "FRI", sat: "SAT", sun: "SUN" };
const PHASE_LABELS = { base: "Base", build: "Build", peak: "Peak", taper: "Taper" };

// Known race-date → friendly-name lookups. Add more here as anchor races emerge.
const RACE_NAMES = {
  "2026-10-11": "Chicago Marathon 2026",
};

// Easy-day rotation by long-run choice. Generator picks the first N days from
// the priority list to fill out daysPerWeek (after seating long + workout).
const EASY_DAY_PRIORITY = {
  "sat": ["thu", "sun", "wed", "fri", "mon"], // Sat long, Tue workout
  "sun": ["fri", "mon", "thu", "sat", "tue"], // Sun long, Wed workout
};

// Sensible time bounds per race distance (in seconds). Generous on both ends
// to fit elite + recreational runners without false negatives.
const RACE_TIME_RANGES = {
  "5k":            { min: 600,  max: 3600  }, // 10:00 – 1:00:00
  "10k":           { min: 1500, max: 7200  }, // 25:00 – 2:00:00
  "half-marathon": { min: 3000, max: 14400 }, // 50:00 – 4:00:00
  "marathon":      { min: 7200, max: 28800 }, // 2:00:00 – 8:00:00
};

// ─────────────────────────────────────────────
// Race-time helpers — parse flexible input, format for display
// ─────────────────────────────────────────────

function parseRaceTime(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n) || n < 0)) return null;
  let seconds;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    // Assume minutes if a single integer
    seconds = parts[0] * 60;
  } else {
    return null;
  }
  return seconds > 0 ? seconds : null;
}

function formatRaceTime(seconds) {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

// ─────────────────────────────────────────────
// Pace helpers — MM:SS strings ↔ seconds per mile
// Bounded 4:00 – 15:00/mi (240 – 900 sec).
// ─────────────────────────────────────────────

function parsePaceString(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const sec = parseInt(m[2], 10);
  if (isNaN(min) || isNaN(sec) || sec >= 60 || min < 0) return null;
  const total = min * 60 + sec;
  if (total < 240 || total > 900) return null;
  return total;
}

function formatPaceSec(sec) {
  if (!sec) return "";
  const min = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${min}:${String(s).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────
// Templates — inlined so they're available synchronously without a fetch.
// Single source of truth; lookups/runbook-templates.json is kept as a
// human-readable mirror but not loaded at runtime.
// ─────────────────────────────────────────────

const TEMPLATES = {
  engine_version: "runbook-v1.0",

  default_paces_min_per_mi: {
    easy: 9.5,
    long: 9.5,
    workout: 8.0,
  },

  phase_workouts_shared: {
    base: [
      { label: "Strides",      workout: "6 × 20-sec strides at race effort with full recovery, after a 3-mi easy run", effort: "easy + neuromuscular" },
      { label: "Hill strides", workout: "5 × 60-sec uphill at strong effort, walk-down recovery — or 5 × 60-sec hard on flat at 5K effort with 90-sec jog recovery if no hills. Easy warmup + cooldown either way.", effort: "moderate-hard, neuromuscular" },
      { label: "Easy tempo",   workout: "2 mi easy + 2 mi at comfortable hard effort + 2 mi easy", effort: "moderate / sub-threshold" },
      { label: "Progression",  workout: "Run easy → moderate → strong, ~1.5 mi each segment", effort: "easy → moderate → hard" },
      { label: "Fartlek",      workout: "20 min easy with 5 × 1-min surges at 5K effort, 1 min easy between", effort: "easy with surges" },
    ],
  },

  goals: {
    "5k": {
      label: "5K",
      race_distance_mi: 3.1,
      phase_distribution: { base: 0.40, build: 0.40, peak: 0.15, taper: 0.05 },
      peak_volume_mi: { minimum: 18, recommended: 28, aggressive: 45 },
      long_run_cap_mi: 10,
      workouts: {
        build: [
          { label: "Mile repeats",      workout: "3 × 1 mi at 5K effort, 2-min jog recovery", effort: "5K race effort" },
          { label: "800m × 5",          workout: "5 × 800m at 5K-10K effort, 90-sec jog recovery", effort: "5K-10K effort" },
          { label: "Cruise intervals",  workout: "4 × 1 mi at threshold effort, 60-sec recovery", effort: "threshold" },
          { label: "Fartlek",           workout: "10 × 1-min at 5K effort, 1-min easy between", effort: "5K effort" },
          { label: "Threshold tempo",   workout: "3 mi at threshold effort, after easy warmup", effort: "threshold" },
        ],
        peak: [
          { label: "400m × 8",   workout: "8 × 400m at 5K effort, 200m jog recovery", effort: "5K race effort" },
          { label: "1K × 4",     workout: "4 × 1K at 5K effort, 90-sec jog recovery", effort: "5K race effort" },
          { label: "Pyramid",    workout: "200-400-800-400-200 at 5K-3K effort, equal-distance jog recovery", effort: "5K-3K mixed" },
          { label: "Race sim",   workout: "2 mi at 5K effort, 4-min easy, 1 mi all-out", effort: "race pace + push" },
          { label: "Short reps", workout: "10 × 200m at 3K effort, 200m jog", effort: "3K effort" },
        ],
        taper: [
          { label: "Tune-up",      workout: "3 × 400m at race pace, full recovery between", effort: "race effort, fresh legs" },
          { label: "Race strides", workout: "6 × 30-sec at race pace with full recovery, after easy warmup", effort: "race effort, neuromuscular" },
          { label: "Shakeout",     workout: "Easy 20-min run with 4 × 20-sec race-pace pickups in the last mile", effort: "easy + pickups" },
        ],
      },
    },

    "10k": {
      label: "10K",
      race_distance_mi: 6.2,
      phase_distribution: { base: 0.40, build: 0.40, peak: 0.15, taper: 0.05 },
      peak_volume_mi: { minimum: 22, recommended: 35, aggressive: 55 },
      long_run_cap_mi: 12,
      workouts: {
        build: [
          { label: "Mile repeats",       workout: "4 × 1 mi at 10K effort, 90-sec jog recovery", effort: "10K race effort" },
          { label: "1K × 5",             workout: "5 × 1K at 10K-5K effort, 90-sec jog recovery", effort: "10K-5K effort" },
          { label: "Threshold tempo",    workout: "4 mi at threshold effort", effort: "threshold" },
          { label: "Cruise intervals",   workout: "5 × 1 mi at threshold effort, 60-sec recovery", effort: "threshold" },
          { label: "Fartlek",            workout: "12 × 1-min at 10K effort, 1-min easy between", effort: "10K effort" },
        ],
        peak: [
          { label: "1 mi × 5",         workout: "5 × 1 mi at 10K effort, 90-sec recovery", effort: "10K race effort" },
          { label: "2K × 3",           workout: "3 × 2K at 10K effort, 2-min jog recovery", effort: "10K race effort" },
          { label: "Mixed pace",       workout: "2 mi at threshold + 4 × 800m at 5K effort with 90-sec recovery", effort: "mixed: threshold + 5K" },
          { label: "Race sim",         workout: "3 mi at 10K effort, 5-min easy, 1 mi at 5K effort", effort: "race pace + sharpener" },
          { label: "Cruise intervals", workout: "6 × 1K at threshold effort, 60-sec recovery", effort: "threshold" },
        ],
        taper: [
          { label: "Tune-up",      workout: "3 × 600m at race pace, 90-sec recovery", effort: "race effort, fresh legs" },
          { label: "Race strides", workout: "6 × 30-sec at race pace with full recovery, after easy warmup", effort: "race effort, neuromuscular" },
          { label: "Shakeout",     workout: "Easy 25-min run with 4 × 30-sec race-pace pickups", effort: "easy + pickups" },
        ],
      },
    },

    "half-marathon": {
      label: "Half marathon",
      race_distance_mi: 13.1,
      phase_distribution: { base: 0.45, build: 0.35, peak: 0.15, taper: 0.05 },
      peak_volume_mi: { minimum: 25, recommended: 38, aggressive: 60 },
      long_run_cap_mi: 12,
      workouts: {
        build: [
          { label: "Mile repeats",      workout: "5 × 1 mi at half-marathon effort, 90-sec jog recovery", effort: "half-marathon race effort" },
          { label: "Threshold tempo",   workout: "5 mi at threshold effort", effort: "threshold" },
          { label: "Cruise intervals",  workout: "4 × 1.5 mi at threshold effort, 90-sec recovery", effort: "threshold" },
          { label: "Steady-state",      workout: "6 mi at moderate effort (just below threshold)", effort: "moderate" },
          { label: "Progression LR",    workout: "Long run with last 3 mi at half-marathon effort", effort: "easy → race effort" },
        ],
        peak: [
          { label: "2 mi × 3",          workout: "3 × 2 mi at half-marathon effort, 3-min recovery", effort: "half-marathon race effort" },
          { label: "Half-pace block",   workout: "6 mi at half-marathon effort, after easy warmup", effort: "half-marathon race effort" },
          { label: "Mixed pace",        workout: "3 × 1 mi at threshold + 3 × 1 mi at half-marathon effort, 90-sec recovery", effort: "threshold → race effort" },
          { label: "Race-pace LR",      workout: "Long run with last 5 mi at half-marathon effort", effort: "easy → race effort" },
          { label: "Cruise intervals",  workout: "5 × 1 mi at threshold effort, 60-sec recovery", effort: "threshold" },
        ],
        taper: [
          { label: "Tune-up",          workout: "4 × 800m at race pace, 90-sec recovery", effort: "race effort, fresh legs" },
          { label: "Race-pace miles",  workout: "2 × 1 mi at half-marathon effort, 3-min easy between", effort: "race effort" },
          { label: "Shakeout",         workout: "Easy 30-min run with 4 × 30-sec race-pace pickups", effort: "easy + pickups" },
        ],
      },
    },

    "marathon": {
      label: "Marathon",
      race_distance_mi: 26.2,
      phase_distribution: { base: 0.50, build: 0.30, peak: 0.12, taper: 0.08 },
      peak_volume_mi: { minimum: 30, recommended: 50, aggressive: 75 },
      long_run_cap_mi: 22,
      workouts: {
        build: [
          { label: "Marathon-pace miles", workout: "4 × 1 mi at marathon effort, 90-sec recovery", effort: "marathon race effort" },
          { label: "Threshold tempo",     workout: "5 mi at threshold effort (just below half-marathon pace)", effort: "threshold" },
          { label: "Steady-state",        workout: "8 mi at moderate effort", effort: "moderate / aerobic" },
          { label: "Cruise intervals",    workout: "4 × 1.5 mi at threshold effort, 90-sec recovery", effort: "threshold" },
          { label: "Progression LR",      workout: "Long run with last 3 mi at marathon effort", effort: "easy → race effort" },
        ],
        peak: [
          { label: "MP block",         workout: "8 mi at marathon effort, after easy warmup", effort: "marathon race effort" },
          { label: "Race-pace LR",     workout: "Long run with last 6 mi at marathon effort", effort: "easy → race effort" },
          { label: "2 mi × 3",         workout: "3 × 2 mi at half-marathon effort, 3-min recovery", effort: "half-marathon effort" },
          { label: "Mixed pace LR",    workout: "Long run: middle 4 mi at marathon effort, finish 2 mi at half-marathon effort", effort: "marathon → half-marathon effort" },
          { label: "Cruise intervals", workout: "6 × 1 mi at threshold effort, 60-sec recovery", effort: "threshold" },
        ],
        taper: [
          { label: "MP tune-up",         workout: "3 × 1 mi at marathon effort, 90-sec recovery", effort: "marathon race effort, fresh legs" },
          { label: "Short race strides", workout: "6 × 30-sec at half-marathon effort with full recovery, after easy warmup", effort: "race effort, neuromuscular" },
          { label: "Shakeout",           workout: "Easy 30-min run with 4 × 30-sec marathon-pace pickups", effort: "easy + pickups" },
        ],
      },
    },

    "base": {
      label: "Base fitness",
      race_distance_mi: null,
      phase_distribution: { base: 1.0, build: 0.0, peak: 0.0, taper: 0.0 },
      peak_volume_mi: { minimum: 15, recommended: 25, aggressive: 40 },
      long_run_cap_mi: 14,
      workouts: {
        build: [],
        peak: [],
        taper: [],
      },
    },
  },
};

// ─────────────────────────────────────────────
// Cross-tool hints — borrow unit pref + weekly mileage from Haul if it's there.
// Cheap UX win for users who've already used Haul.
// ─────────────────────────────────────────────

function loadHaulHints() {
  try {
    const haul = JSON.parse(localStorage.getItem("coreon-haul-state") || "{}");
    return {
      units:    haul.stats?.units    || "imperial",
      weeklyKm: haul.training?.weeklyKm ?? null,
    };
  } catch {
    return { units: "imperial", weeklyKm: null };
  }
}

// ─────────────────────────────────────────────
// State persistence
// ─────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

// Cloud write-through stays off until the initial restore check has run, so a
// fresh-device render can never overwrite saved preferences before we pull them.
let syncEnabled = false;

function saveState(s) {
  try {
    s.engine_version = ENGINE_VERSION;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage can throw in private mode — fail silently.
  }
  if (syncEnabled) pushRemote(STORAGE_KEY, s); // no-op when signed out
}

const state     = loadState();
const haulHints = loadHaulHints();

state.engine_version = state.engine_version || ENGINE_VERSION;
state.units          = state.units          || haulHints.units;
state.goal           = state.goal           || null;
state.currentState   = state.currentState   || {};
state.schedule       = state.schedule       || {};
// `state.schedule.workoutDay` and `state.schedule.crossTrainDays` were removed.
// Clean them up from any state saved by earlier builds.
if (state.schedule.workoutDay) delete state.schedule.workoutDay;
if (state.schedule.crossTrainDays) delete state.schedule.crossTrainDays;

// First-visit prefill from Haul (if the user has Haul training data already).
if (state.currentState.weeklyMi == null && haulHints.weeklyKm != null) {
  state.currentState.weeklyMi = state.units === "imperial"
    ? Math.round((haulHints.weeklyKm / 1.609344) * 10) / 10
    : Math.round(haulHints.weeklyKm * 10) / 10;
}

// Sensible defaults for Step 3 — selecting them up-front avoids forcing a click
// the user would just leave on the default anyway.
if (!state.schedule.raceDate)   state.schedule.raceDate   = "2026-10-11";
if (!state.schedule.longRunDay) state.schedule.longRunDay = "sat";

// ─────────────────────────────────────────────
// Engine — plan generator (M1 deterministic)
// Pure functions: state + templates → output JSON per spec §5g.
// ─────────────────────────────────────────────

function weeksUntil(dateStr) {
  if (!dateStr) return 12;
  const target = new Date(dateStr + "T00:00:00");
  const today  = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
  return Math.max(0, Math.ceil(days / 7));
}

function computeAmbition(prSec, goalSec) {
  if (!prSec || !goalSec || prSec <= 0) return null;
  return (prSec - goalSec) / prSec;
}

function computePeakMileage(template, currentMi, prSec, goalSec) {
  const { minimum, recommended, aggressive } = template.peak_volume_mi;
  // Baseline: 1.6× current, capped within template bounds.
  let peak = Math.min(currentMi * 1.6, recommended);
  peak = Math.max(peak, minimum);
  if (currentMi > recommended) peak = Math.max(currentMi, peak);

  // Ambition adjustment (race goals only — both PR + goal time provided).
  const ambition = computeAmbition(prSec, goalSec);
  if (ambition !== null) {
    if (ambition >= 0.08) {
      // Aggressive goal: pull peak toward the aggressive ceiling.
      peak = Math.max(peak, (recommended + aggressive) / 2);
    } else if (ambition < 0) {
      // Goal slower than PR (comeback / casual): cap at recommended, floor at minimum.
      peak = Math.max(minimum, Math.min(peak, recommended));
    }
    // 0–8% ambition: leave the baseline alone.
  }

  peak = Math.min(peak, aggressive);
  return Math.round(peak);
}

function computePhaseWeeks(template, totalWeeks, goal) {
  const dist  = template.phase_distribution;
  let base    = Math.floor(totalWeeks * dist.base);
  let build   = Math.floor(totalWeeks * dist.build);
  let peak    = Math.floor(totalWeeks * dist.peak);
  let taper   = Math.floor(totalWeeks * dist.taper);

  // Enforce minimums for race goals (taper ≥ 1, peak ≥ 1, build ≥ 2).
  if (goal !== "base") {
    if (peak  < 1 && dist.peak  > 0) peak  = 1;
    if (taper < 1 && dist.taper > 0) taper = 1;
    if (build < 2 && dist.build > 0) build = 2;
  }
  // Base gets the remainder so phases always sum to totalWeeks.
  base = Math.max(0, totalWeeks - build - peak - taper);
  return { base, build, peak, taper };
}

function phaseForWeek(idx, phaseWeeks) {
  if (idx < phaseWeeks.base) return "base";
  if (idx < phaseWeeks.base + phaseWeeks.build) return "build";
  if (idx < phaseWeeks.base + phaseWeeks.build + phaseWeeks.peak) return "peak";
  return "taper";
}

function buildMileageCurve(currentMi, peakMi, phaseWeeks) {
  const total = phaseWeeks.base + phaseWeeks.build + phaseWeeks.peak + phaseWeeks.taper;
  const tapStart = phaseWeeks.base + phaseWeeks.build + phaseWeeks.peak;
  const out = [];
  let prev = currentMi;

  for (let i = 0; i < total; i++) {
    const phase      = phaseForWeek(i, phaseWeeks);
    const isRecovery = ((i + 1) % 4 === 0) && phase !== "taper" && i < tapStart - 1;
    let mi;

    if (phase === "taper") {
      // Aggressive 2-3 week taper. 70% → 50% → 35%.
      const t = i - tapStart;
      const ratio = t === 0 ? 0.70 : (t === 1 ? 0.50 : 0.35);
      mi = peakMi * ratio;
    } else if (isRecovery) {
      mi = prev * 0.75;
    } else {
      // 10% rule, capped at peak.
      mi = Math.min(prev * 1.10, peakMi);
    }

    out.push({ mi: Math.round(mi), phase, isRecovery });
    prev = mi;
  }
  return out;
}

function generateWeekDays(weekMi, phase, weekIdxInPhase, daysPerWeek, longRunDay, template, sharedBase) {
  const workoutDay = longRunDay === "sat" ? "tue" : "wed";

  // Long run: max 30% of week, capped at template's hard cap.
  const longCap = template.long_run_cap_mi || 22;
  let longMi = Math.round(Math.min(weekMi * 0.30, longCap));
  if (weekMi > 10) longMi = Math.max(longMi, 5);

  // Workout: ~18% of week, min 3 mi.
  const workoutMi = Math.max(3, Math.round(weekMi * 0.18));

  // Rotate through phase's workout library deterministically.
  const lib = phase === "base" ? sharedBase : (template.workouts[phase] || []);
  const workout = lib.length > 0 ? lib[weekIdxInPhase % lib.length] : null;

  // Pick run days: long + workout always; rest from easy priority.
  const runDays  = new Set([longRunDay]);
  if (workout) runDays.add(workoutDay);
  const easyList = EASY_DAY_PRIORITY[longRunDay] || EASY_DAY_PRIORITY["sat"];
  const easyNeeded = daysPerWeek - runDays.size;
  for (let i = 0; i < easyNeeded && i < easyList.length; i++) runDays.add(easyList[i]);

  // Easy-day distance: split remaining weekly volume.
  const easyTotal = Math.max(0, weekMi - longMi - (workout ? workoutMi : 0));
  const easyDayCount = Math.max(0, daysPerWeek - runDays.size + (runDays.size - (workout ? 2 : 1)));
  // ^ easy days = daysPerWeek minus the long + workout slots.
  const easyMi = easyDayCount > 0 ? Math.max(1, Math.round(easyTotal / easyDayCount)) : 0;

  return DAYS_OF_WEEK.map((day) => {
    if (day === longRunDay) {
      return {
        day,
        type: "long",
        distance_mi: longMi,
        effort: "easy / conversation",
        label: "Long run",
      };
    }
    if (workout && day === workoutDay) {
      return {
        day,
        type: "workout",
        distance_mi: workoutMi,
        workout: workout.workout,
        effort: workout.effort,
        label: workout.label,
      };
    }
    if (runDays.has(day)) {
      return {
        day,
        type: "easy",
        distance_mi: easyMi,
        label: "Easy run",
      };
    }
    return { day, type: "rest", label: "Rest" };
  });
}

function generateRunbook(state, templates) {
  const goal = state.goal;
  const t    = templates.goals[goal];
  if (!t) throw new Error("Unknown goal: " + goal);

  const { weeklyMi, daysPerWeek, prSeconds, goalTimeSeconds } = state.currentState;
  const { raceDate, longRunDay } = state.schedule;

  let totalWeeks;
  if (goal === "base") {
    totalWeeks = 12;
  } else {
    totalWeeks = Math.max(6, Math.min(28, weeksUntil(raceDate)));
  }

  const peakMi     = computePeakMileage(t, weeklyMi, prSeconds, goalTimeSeconds);
  const phaseWeeks = computePhaseWeeks(t, totalWeeks, goal);
  const ambition   = computeAmbition(prSeconds, goalTimeSeconds);
  const curve       = buildMileageCurve(weeklyMi, peakMi, phaseWeeks);
  const workoutDay  = longRunDay === "sat" ? "tue" : "wed";
  const sharedBase  = templates.phase_workouts_shared.base;
  const paceTable   = computePaceTable(state, t, goal);

  const weeks = curve.map((wk, idx) => {
    const phase = wk.phase;
    let inPhase = idx;
    if (phase === "build") inPhase = idx - phaseWeeks.base;
    if (phase === "peak")  inPhase = idx - phaseWeeks.base - phaseWeeks.build;
    if (phase === "taper") inPhase = idx - phaseWeeks.base - phaseWeeks.build - phaseWeeks.peak;

    const days = generateWeekDays(wk.mi, phase, inPhase, daysPerWeek, longRunDay, t, sharedBase);
    return {
      number: idx + 1,
      phase,
      is_recovery: wk.isRecovery,
      total_mi: wk.mi,
      days,
    };
  });

  return {
    meta: {
      goal,
      goal_label: GOAL_LABELS[goal],
      weeks: totalWeeks,
      race_date: goal === "base" ? null : raceDate,
      race_name: goal === "base" ? null : (RACE_NAMES[raceDate] || null),
      peak_weekly_mi: peakMi,
      long_run_day: longRunDay,
      workout_day: workoutDay,
      pr_seconds: goal === "base" ? null : (prSeconds || null),
      goal_time_seconds: goal === "base" ? null : (goalTimeSeconds || null),
      ambition_pct: ambition !== null ? Math.round(ambition * 1000) / 10 : null,
      derived_paces: paceTable,
      engine_version: templates.engine_version,
    },
    weeks,
  };
}

// ─────────────────────────────────────────────
// Validation umbrella
// ─────────────────────────────────────────────

function validateGoal() {
  return !!state.goal && Object.keys(GOAL_LABELS).includes(state.goal);
}

function validateState() {
  const s = state.currentState;
  if (s.weeklyMi == null || s.weeklyMi < 0 || s.weeklyMi > 200) return false;
  if (s.longRunMi == null || s.longRunMi < 0 || s.longRunMi > 50) return false;
  if (!s.daysPerWeek || s.daysPerWeek < 3 || s.daysPerWeek > 6) return false;
  // PR + goal time required for race goals; range-checked when ranges exist.
  if (state.goal && state.goal !== "base") {
    if (!s.prSeconds || s.prSeconds <= 0) return false;
    if (!s.goalTimeSeconds || s.goalTimeSeconds <= 0) return false;
    const range = RACE_TIME_RANGES[state.goal];
    if (range) {
      if (s.prSeconds < range.min || s.prSeconds > range.max) return false;
      if (s.goalTimeSeconds < range.min || s.goalTimeSeconds > range.max) return false;
    }
  }
  // Pace inputs are optional but bounded when filled. Tempo must be faster than easy.
  if (s.easyPaceSec  != null && (s.easyPaceSec  < 240 || s.easyPaceSec  > 900)) return false;
  if (s.tempoPaceSec != null && (s.tempoPaceSec < 240 || s.tempoPaceSec > 900)) return false;
  if (s.easyPaceSec != null && s.tempoPaceSec != null && s.tempoPaceSec >= s.easyPaceSec) return false;
  return true;
}

function validateSchedule() {
  if (!state.schedule.longRunDay) return false;
  // Race date only required for race goals
  if (state.goal !== "base" && !state.schedule.raceDate) return false;
  return true;
}

function isAllValid() {
  return validateGoal() && validateState() && validateSchedule();
}

// ─────────────────────────────────────────────
// Step routing
// ─────────────────────────────────────────────

const stepLabel    = document.getElementById("step-label");
const stepProgress = document.getElementById("step-progress");

function getStepFromHash() {
  const hash = (window.location.hash || "").replace(/^#/, "");
  if (STEPS.includes(hash)) return hash;
  // No explicit hash — drop returning users at the first incomplete step,
  // or at the result if everything's valid.
  if (isAllValid())                       return "result";
  if (validateGoal() && validateState())  return "schedule";
  if (validateGoal())                     return "state";
  return "goal";
}

function showStep(step) {
  document.querySelectorAll(".haul-step").forEach((el) => {
    el.hidden = el.dataset.step !== step;
  });

  const meta = STEP_META[step] || STEP_META.goal;
  stepLabel.textContent = meta.label;
  stepProgress.style.width = `${meta.progress}%`;

  // Move keyboard focus to the visible step's heading for screen readers.
  const visible = document.querySelector(`.haul-step[data-step="${step}"]`);
  const heading = visible?.querySelector("h1, h2");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }

  window.scrollTo({ top: 0, behavior: "smooth" });

  if (step === "state") {
    updateStateGoalSummary();
    renderStateForm();
    updateStateContinue();
  } else if (step === "schedule") {
    updateScheduleGoalSummary();
    renderScheduleForm();
    updateScheduleContinue();
  } else if (step === "result") {
    renderResult();
  }
}

window.addEventListener("hashchange", () => showStep(getStepFromHash()));

// ─────────────────────────────────────────────
// Step 1 — Goal
// ─────────────────────────────────────────────

const goalCards       = Array.from(document.querySelectorAll("[data-goal]"));
const goalContinueBtn = document.getElementById("runbook-goal-continue");
const goalHelper      = document.getElementById("runbook-goal-helper");

function applyGoalSelection(goal) {
  goalCards.forEach((card) => {
    const isSelected = card.dataset.goal === goal;
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-checked", isSelected ? "true" : "false");
  });

  const hasGoal = !!goal;
  goalContinueBtn.disabled = !hasGoal;
  goalContinueBtn.setAttribute("aria-disabled", hasGoal ? "false" : "true");
  goalHelper.textContent = hasGoal
    ? `Goal: ${GOAL_LABELS[goal] || goal}`
    : "Pick a goal to continue.";
}

goalCards.forEach((card) => {
  card.addEventListener("click", () => {
    state.goal = card.dataset.goal;
    saveState(state);
    applyGoalSelection(state.goal);
    updateStateGoalSummary();
    updateScheduleGoalSummary();
    updateRaceTimePlaceholders();
    updateStateContinue();
  });

  card.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = goalCards.indexOf(card);
    const next = e.key === "ArrowRight"
      ? goalCards[(idx + 1) % goalCards.length]
      : goalCards[(idx - 1 + goalCards.length) % goalCards.length];
    next.focus();
    next.click();
  });
});

goalContinueBtn.addEventListener("click", () => {
  if (!validateGoal()) return;
  window.location.hash = "#state";
});

// ─────────────────────────────────────────────
// Step 2 — Current state
// ─────────────────────────────────────────────

const stateForm           = document.getElementById("runbook-state-form");
const stateContinueBtn    = document.getElementById("runbook-state-continue");
const stateHelper         = document.getElementById("runbook-state-helper");
const stateGoalSummary    = document.getElementById("runbook-state-goal-summary");
const weeklyMileageInput  = document.getElementById("runbook-weekly-mileage");
const longRunInput        = document.getElementById("runbook-long-run");
const easyPaceInput       = document.getElementById("runbook-easy-pace");
const tempoPaceInput      = document.getElementById("runbook-tempo-pace");
const prInput             = document.getElementById("runbook-pr");
const goalTimeInput       = document.getElementById("runbook-goal-time");
const raceFieldsRow       = document.getElementById("runbook-race-fields");
const daysPerWeekOptions  = Array.from(document.querySelectorAll("[data-days-per-week]"));

function updateStateGoalSummary() {
  if (!stateGoalSummary) return;
  stateGoalSummary.textContent = state.goal ? GOAL_LABELS[state.goal] : "Not set";
  // Hide PR + goal-time row when goal is Base fitness (no race to target).
  if (raceFieldsRow) raceFieldsRow.hidden = state.goal === "base";
}

function applyDaysPerWeekSelection() {
  daysPerWeekOptions.forEach((btn) => {
    const active = parseInt(btn.dataset.daysPerWeek, 10) === state.currentState.daysPerWeek;
    btn.classList.toggle("selected", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function renderStateForm() {
  weeklyMileageInput.value = state.currentState.weeklyMi != null
    ? String(state.currentState.weeklyMi) : "";
  longRunInput.value = state.currentState.longRunMi != null
    ? String(state.currentState.longRunMi) : "";
  if (easyPaceInput) {
    easyPaceInput.value = state.currentState.easyPaceSec
      ? formatPaceSec(state.currentState.easyPaceSec) : "";
  }
  if (tempoPaceInput) {
    tempoPaceInput.value = state.currentState.tempoPaceSec
      ? formatPaceSec(state.currentState.tempoPaceSec) : "";
  }
  if (prInput) {
    prInput.value = state.currentState.prSeconds
      ? formatRaceTime(state.currentState.prSeconds) : "";
  }
  if (goalTimeInput) {
    goalTimeInput.value = state.currentState.goalTimeSeconds
      ? formatRaceTime(state.currentState.goalTimeSeconds) : "";
  }
  // Update placeholder hints based on the chosen race distance.
  updateRaceTimePlaceholders();
  applyDaysPerWeekSelection();
}

function updateRaceTimePlaceholders() {
  if (!prInput || !goalTimeInput) return;
  const placeholders = {
    "5k":            { pr: "22:30",    goal: "21:00"    },
    "10k":           { pr: "47:00",    goal: "44:00"    },
    "half-marathon": { pr: "1:50:00",  goal: "1:42:00"  },
    "marathon":      { pr: "4:00:00",  goal: "3:45:00"  },
  };
  const ph = placeholders[state.goal] || placeholders["marathon"];
  prInput.placeholder = ph.pr;
  goalTimeInput.placeholder = ph.goal;
}

function readStateForm() {
  const weeklyMi  = parseFloat(weeklyMileageInput.value);
  const longRunMi = parseFloat(longRunInput.value);
  const prSeconds       = prInput        ? parseRaceTime(prInput.value)        : null;
  const goalTimeSeconds = goalTimeInput  ? parseRaceTime(goalTimeInput.value)  : null;
  const easyPaceSec     = easyPaceInput  ? parsePaceString(easyPaceInput.value)  : null;
  const tempoPaceSec    = tempoPaceInput ? parsePaceString(tempoPaceInput.value) : null;
  return {
    weeklyMi:        isNaN(weeklyMi)  ? null : weeklyMi,
    longRunMi:       isNaN(longRunMi) ? null : longRunMi,
    daysPerWeek:     state.currentState.daysPerWeek || null,
    prSeconds:       prSeconds,
    goalTimeSeconds: goalTimeSeconds,
    easyPaceSec:     easyPaceSec,
    tempoPaceSec:    tempoPaceSec,
  };
}

function updateStateContinue() {
  if (!stateContinueBtn) return;
  const valid = validateState();
  stateContinueBtn.disabled = !valid;
  stateContinueBtn.setAttribute("aria-disabled", valid ? "false" : "true");

  if (valid) {
    stateHelper.textContent = "Looks good — continue when ready.";
    return;
  }

  const s = state.currentState;
  if (s.weeklyMi == null)       stateHelper.textContent = "Fill in your current weekly mileage to continue.";
  else if (s.longRunMi == null) stateHelper.textContent = "Add your recent long run to continue.";
  else if (!s.daysPerWeek)      stateHelper.textContent = "Pick how many days per week you can run.";
  else if (state.goal !== "base" && !s.prSeconds)       stateHelper.textContent = "Enter your personal record for this distance.";
  else if (state.goal !== "base" && !s.goalTimeSeconds) stateHelper.textContent = "Enter your goal time for the race.";
  else                                                  stateHelper.textContent = "Some values look off — please check.";
}

function saveStateForm() {
  const inputs = readStateForm();
  state.currentState = { ...state.currentState, ...inputs };
  saveState(state);
  updateStateContinue();
}

weeklyMileageInput.addEventListener("input", saveStateForm);
longRunInput.addEventListener("input", saveStateForm);
if (prInput)        prInput.addEventListener("input", saveStateForm);
if (goalTimeInput)  goalTimeInput.addEventListener("input", saveStateForm);
if (easyPaceInput)  easyPaceInput.addEventListener("input", saveStateForm);
if (tempoPaceInput) tempoPaceInput.addEventListener("input", saveStateForm);

daysPerWeekOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.currentState.daysPerWeek = parseInt(btn.dataset.daysPerWeek, 10);
    saveState(state);
    applyDaysPerWeekSelection();
    updateStateContinue();
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = daysPerWeekOptions.indexOf(btn);
    const next = e.key === "ArrowRight"
      ? daysPerWeekOptions[(idx + 1) % daysPerWeekOptions.length]
      : daysPerWeekOptions[(idx - 1 + daysPerWeekOptions.length) % daysPerWeekOptions.length];
    next.focus();
    next.click();
  });
});

stateContinueBtn.addEventListener("click", () => {
  if (!validateState()) return;
  window.location.hash = "#schedule";
});

stateForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!stateContinueBtn.disabled) stateContinueBtn.click();
});

// ─────────────────────────────────────────────
// Step 3 — Schedule
// ─────────────────────────────────────────────

const scheduleForm        = document.getElementById("runbook-schedule-form");
const scheduleContinueBtn = document.getElementById("runbook-schedule-continue");
const scheduleHelper      = document.getElementById("runbook-schedule-helper");
const scheduleGoalSummary = document.getElementById("runbook-schedule-goal-summary");
const raceDateInput       = document.getElementById("runbook-race-date");
const raceDateField       = document.getElementById("runbook-race-date-field");
const longRunDayOptions   = Array.from(document.querySelectorAll("[data-long-run-day]"));

function updateScheduleGoalSummary() {
  if (!scheduleGoalSummary) return;
  scheduleGoalSummary.textContent = state.goal ? GOAL_LABELS[state.goal] : "Not set";

  // Base fitness: no race, no race-date field.
  if (raceDateField) raceDateField.hidden = state.goal === "base";
}

function applyLongRunDaySelection() {
  longRunDayOptions.forEach((btn) => {
    const active = btn.dataset.longRunDay === state.schedule.longRunDay;
    btn.classList.toggle("selected", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function renderScheduleForm() {
  raceDateInput.value = state.schedule.raceDate || "2026-10-11";
  applyLongRunDaySelection();
}

function updateScheduleContinue() {
  if (!scheduleContinueBtn) return;
  const valid = validateSchedule();
  scheduleContinueBtn.disabled = !valid;
  scheduleContinueBtn.setAttribute("aria-disabled", valid ? "false" : "true");
  scheduleHelper.textContent = valid
    ? "Looks good — let's generate your runbook."
    : "Pick a long run day to continue.";
}

raceDateInput.addEventListener("input", () => {
  state.schedule.raceDate = raceDateInput.value || null;
  saveState(state);
  updateScheduleContinue();
});

longRunDayOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.schedule.longRunDay = btn.dataset.longRunDay;
    saveState(state);
    applyLongRunDaySelection();
    updateScheduleContinue();
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = longRunDayOptions.indexOf(btn);
    const next = e.key === "ArrowRight"
      ? longRunDayOptions[(idx + 1) % longRunDayOptions.length]
      : longRunDayOptions[(idx - 1 + longRunDayOptions.length) % longRunDayOptions.length];
    next.focus();
    next.click();
  });
});

scheduleContinueBtn.addEventListener("click", () => {
  if (!validateSchedule()) return;
  // The result page is a placeholder for now — generator lands next.
  window.location.hash = "#result";
});

scheduleForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!scheduleContinueBtn.disabled) scheduleContinueBtn.click();
});

// ─────────────────────────────────────────────
// Step 4 — Result rendering
// ─────────────────────────────────────────────

const subheadEl    = document.getElementById("runbook-subhead");
const summaryEl    = document.getElementById("runbook-summary");
const weeksEl      = document.getElementById("runbook-weeks");
const whyTextEl    = document.getElementById("runbook-why-text");
const pdfBtn       = document.getElementById("runbook-pdf-btn");
const calBtn       = document.getElementById("runbook-cal-btn");

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRaceDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// `CURRENT_PACES` holds the personalized paces for the runbook being rendered.
// `CURRENT_GOAL` is the goal key (for "race effort" → which race pace).
// Both set in renderRunbookView(); read by durationFromMi() and injectPaces().
let CURRENT_PACES = null;
let CURRENT_GOAL  = null;

function durationFromMi(mi, type) {
  if (!mi) return "";
  let paceMinPerMi;
  if (CURRENT_PACES) {
    paceMinPerMi = type === "workout" ? CURRENT_PACES.workout_min_per_mi
                 : type === "long"    ? CURRENT_PACES.long_min_per_mi
                 :                       CURRENT_PACES.easy_min_per_mi;
  } else {
    const def = TEMPLATES.default_paces_min_per_mi;
    paceMinPerMi = type === "workout" ? def.workout : (type === "long" ? def.long : def.easy);
  }
  const total = mi * paceMinPerMi;
  if (total < 60) return "~" + Math.round(total) + " min";
  const h = Math.floor(total / 60);
  const m = Math.round(total - h * 60);
  return "~" + h + "h " + m + "m";
}

// ─────────────────────────────────────────────
// Pace injection — append numeric paces to workout descriptions.
// Only runs when CURRENT_PACES.source === "direct" (the user provided enough
// data to make every zone trustworthy). Otherwise descriptions stay as-is.
// ─────────────────────────────────────────────

const PACE_TOKEN_REGEX = /(at\s+)(5K|10K|half[- ]?marathon|marathon|threshold|race)(\s+(?:effort|pace))?/gi;

const GOAL_TO_RACE_KEY = {
  "marathon":      "marathon",
  "half-marathon": "half",
  "10k":           "10k",
  "5k":            "5k",
};

function injectPaces(description, paces, goal) {
  if (!description || !paces || paces.source !== "direct") return description;

  const goalRaceKey = GOAL_TO_RACE_KEY[goal] || "marathon";

  return description.replace(PACE_TOKEN_REGEX, (match, atPart, effort, suffix) => {
    suffix = suffix || "";
    const e = effort.toLowerCase().replace(/\s+/, "").replace("-", "");
    let key;
    if (e === "5k")                        key = "5k";
    else if (e === "10k")                  key = "10k";
    else if (e.startsWith("halfmarathon")) key = "half";
    else if (e === "marathon")             key = "marathon";
    else if (e === "threshold")            key = "threshold";
    else if (e === "race")                 key = goalRaceKey;
    else return match;

    const paceVal = paces[`${key}_min_per_mi`];
    if (!paceVal) return match;
    return `${atPart}${effort}${suffix} (~${formatMinPerMi(paceVal)})`;
  });
}

function renderSummary(rb) {
  const m       = rb.meta;
  const target  = m.race_name
    ? `${m.race_name}<br><span class="runbook-summary-sub">${formatRaceDate(m.race_date)}</span>`
    : "Ongoing";
  const goalSub = m.goal_time_seconds && m.pr_seconds
    ? `<span class="runbook-summary-sub">${formatRaceTime(m.goal_time_seconds)} from ${formatRaceTime(m.pr_seconds)}</span>`
    : "";
  summaryEl.innerHTML = `
    <div class="runbook-summary-grid">
      <div>
        <p class="runbook-summary-label">Goal</p>
        <p class="runbook-summary-value">${escapeHtml(m.goal_label)}${goalSub}</p>
      </div>
      <div>
        <p class="runbook-summary-label">Length</p>
        <p class="runbook-summary-value">${m.weeks} weeks</p>
      </div>
      <div>
        <p class="runbook-summary-label">Target</p>
        <p class="runbook-summary-value">${target}</p>
      </div>
      <div>
        <p class="runbook-summary-label">Peak mileage</p>
        <p class="runbook-summary-value">${m.peak_weekly_mi} mi/wk</p>
      </div>
    </div>
  `;
}

function renderDay(d) {
  const name = DAY_LABELS[d.day];
  if (d.type === "rest") {
    return `<div class="runbook-day runbook-day-rest">
      <span class="runbook-day-name">${name}</span>
      <span class="runbook-day-rest-text">Rest</span>
    </div>`;
  }
  const dist = d.distance_mi + " mi";
  const dur  = durationFromMi(d.distance_mi, d.type);
  const meta = dur ? `${dist} · ${dur}` : dist;

  if (d.type === "workout") {
    const prescription = injectPaces(d.workout, CURRENT_PACES, CURRENT_GOAL);
    return `<div class="runbook-day runbook-day-workout">
      <span class="runbook-day-name">${name}</span>
      <div class="runbook-day-content">
        <span class="runbook-day-label">${escapeHtml(d.label)}</span>
        <span class="runbook-day-prescription">${escapeHtml(prescription)}</span>
        <span class="runbook-day-meta">${meta}</span>
      </div>
    </div>`;
  }
  if (d.type === "long") {
    return `<div class="runbook-day runbook-day-long">
      <span class="runbook-day-name">${name}</span>
      <div class="runbook-day-content">
        <span class="runbook-day-label">Long run</span>
        <span class="runbook-day-meta">${meta}</span>
      </div>
    </div>`;
  }
  // easy
  return `<div class="runbook-day runbook-day-easy">
    <span class="runbook-day-name">${name}</span>
    <div class="runbook-day-content">
      <span class="runbook-day-label">Easy run</span>
      <span class="runbook-day-meta">${meta}</span>
    </div>
  </div>`;
}

function renderWeek(wk) {
  const phase = wk.is_recovery ? "Recovery" : PHASE_LABELS[wk.phase];
  const days  = wk.days.map(renderDay).join("");
  return `<article class="runbook-week">
    <div class="runbook-week-header">
      <span class="runbook-week-num">Week ${wk.number}</span>
      <span class="runbook-week-phase">${phase}</span>
      <span class="runbook-week-total">${wk.total_mi} mi</span>
    </div>
    <div class="runbook-week-days">${days}</div>
  </article>`;
}

function generateWhyText(rb) {
  const m = rb.meta;
  const paceSourceText = (() => {
    const p = m.derived_paces;
    if (!p) return "";
    if (p.source === "direct") {
      const easy  = formatMinPerMi(p.easy_min_per_mi);
      const tempo = formatMinPerMi(p.threshold_min_per_mi);
      return ` Calendar durations and workout pace prescriptions use your reported paces — easy at ${easy}, tempo at ${tempo}.`;
    }
    if (p.source === "pr") {
      return ` Calendar durations are estimated from your PR pace. Add recent easy + tempo paces on Step 2 to unlock numeric pace prescriptions on workout days — or wait for M2 watch integration.`;
    }
    return ` Durations use default paces (9:30/mi easy). Add your recent paces or PR on Step 2 to personalize them.`;
  })();

  if (m.goal === "base") {
    return `${m.weeks} weeks of base building. Easy mileage with recovery weeks every 4th week. Workouts come from a rotation of strides, hill work, and easy tempo to keep neuromuscular sharpness without overreaching.${paceSourceText}`;
  }
  const raceText  = m.race_name ? `to ${m.race_name}` : "to your race";
  const dayLabel  = (d) => ({mon:"Monday",tue:"Tuesday",wed:"Wednesday",thu:"Thursday",fri:"Friday",sat:"Saturday",sun:"Sunday"}[d]);

  let ambitionText = "";
  if (m.goal_time_seconds && m.pr_seconds) {
    const goalStr = formatRaceTime(m.goal_time_seconds);
    const prStr   = formatRaceTime(m.pr_seconds);
    const pct     = m.ambition_pct;
    if (pct !== null && pct >= 8) {
      ambitionText = ` Going for ${goalStr} from your ${prStr} PR is an ambitious ${pct.toFixed(1)}% improvement — peak mileage is tilted toward the aggressive end of the goal's volume envelope to support it.`;
    } else if (pct !== null && pct < 0) {
      ambitionText = ` Targeting ${goalStr} from your ${prStr} PR is a casual / comeback goal — peak mileage stays modest so the plan supports without overreaching.`;
    } else if (pct !== null) {
      ambitionText = ` Going for ${goalStr} from your ${prStr} PR — a ${pct.toFixed(1)}% improvement — sits in the recommended envelope.`;
    }
  }

  return `${m.weeks} weeks ${raceText}. Plan structured around a ${m.peak_weekly_mi} mi/wk peak, with hard days on ${dayLabel(m.workout_day)} (workout) and ${dayLabel(m.long_run_day)} (long run). Workouts shift through base → build → peak → taper phases. Mileage grows by no more than 10% week-over-week, with recovery weeks every 4th week.${ambitionText}${paceSourceText}`;
}

function renderRunbookView(rb) {
  CURRENT_PACES = rb.meta.derived_paces || null;
  CURRENT_GOAL  = rb.meta.goal;
  subheadEl.textContent = rb.meta.race_name
    ? `${rb.meta.weeks} weeks to ${rb.meta.race_name}.`
    : `${rb.meta.weeks} weeks of base fitness.`;
  renderSummary(rb);
  weeksEl.innerHTML = rb.weeks.map(renderWeek).join("");
  whyTextEl.textContent = generateWhyText(rb);
}

function renderResult() {
  // Defensive: bounce if any prior step is incomplete.
  if (!validateGoal())     { window.location.hash = "#goal";     return; }
  if (!validateState())    { window.location.hash = "#state";    return; }
  if (!validateSchedule()) { window.location.hash = "#schedule"; return; }

  try {
    const rb = generateRunbook(state, TEMPLATES);
    renderRunbookView(rb);
  } catch (err) {
    console.error("Plan generation failed:", err);
    summaryEl.innerHTML = `<p class="runbook-loading">Something went wrong generating your plan. ${escapeHtml(err.message)}</p>`;
  }
}

// ─────────────────────────────────────────────
// Toast (used by visual-placeholder buttons)
// ─────────────────────────────────────────────

function showToast(msg) {
  let toast = document.querySelector(".haul-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "haul-toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 2400);
}

if (pdfBtn) pdfBtn.addEventListener("click", () => showToast("Generate PDF — coming soon."));
if (calBtn) calBtn.addEventListener("click", () => showToast("Export to calendar — coming soon."));

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────

saveState(state); // persist any prefill / defaults (local only until sync enabled)

function boot() {
  applyGoalSelection(state.goal || null);
  updateStateGoalSummary();
  updateScheduleGoalSummary();
  renderStateForm();
  renderScheduleForm();
  updateStateContinue();
  updateScheduleContinue();
  showStep(getStepFromHash());
}

boot();

// Fresh-device restore: if signed in and this device hasn't started a runbook
// yet (no goal chosen), pull the saved preferences and re-render. In-progress
// local work is never clobbered.
pullRemoteIfSignedIn(STORAGE_KEY).then((remote) => {
  if (remote && !state.goal) {
    Object.assign(state, remote);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
    boot();
  }
  syncEnabled = true; // enable cloud write-through now that restore has settled
});
