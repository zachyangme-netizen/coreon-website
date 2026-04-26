const FALLBACK_WORKOUT = {
  title: "Post-run reset",
  duration: "24 min",
  exercises: [
    { name: "Hip flexor stretch", seconds: 120 },
    { name: "Glute bridge hold", seconds: 90 },
    { name: "Single-leg RDL", seconds: 150 },
    { name: "Dead bug", seconds: 120 },
    { name: "Child's pose reset", seconds: 90 },
  ],
  why: "You had a long run yesterday, so Coreon shifted today toward mobility, core stability, and lower fatigue work.",
};

let exercises = [];
let activeIndex = 0;
let remaining = 0;
let intervalId;

const activeLabel = document.getElementById("active-label");
const timerEl = document.getElementById("timer");
const progressBar = document.getElementById("progress-bar");
const workoutList = document.getElementById("workout-list");
const planTitle = document.getElementById("plan-title");
const durationBadge = document.getElementById("duration-badge");
const whyText = document.getElementById("why-text");
const waitlistForm = document.getElementById("waitlist-form");
const formStatus = document.getElementById("form-status");
const appShell = document.querySelector(".app-shell");
const refreshBtn = document.getElementById("refresh-btn");

function formatTime(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function buildWorkoutRows() {
  workoutList.innerHTML = exercises
    .map(
      (ex, i) =>
        `<div class="workout-row${i === 0 ? " active" : ""}" data-index="${i}">` +
        `<span>${ex.name}</span>` +
        `<button type="button">Start</button>` +
        `</div>`
    )
    .join("");

  workoutList.querySelectorAll(".workout-row").forEach((row, index) => {
    row.querySelector("button").addEventListener("click", () => {
      if (activeIndex === index && intervalId) {
        stopDemo();
        return;
      }
      activeIndex = index;
      remaining = exercises[activeIndex].seconds;
      startDemo();
    });
  });
}

function renderDemo() {
  if (!exercises.length) return;
  const exercise = exercises[activeIndex];
  const elapsed = exercise.seconds - remaining;
  const progress = Math.round((elapsed / exercise.seconds) * 100);

  activeLabel.textContent = exercise.name;
  timerEl.textContent = formatTime(remaining);
  progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;

  workoutList.querySelectorAll(".workout-row").forEach((row, index) => {
    const button = row.querySelector("button");
    row.classList.toggle("active", index === activeIndex);
    button.textContent = index === activeIndex && intervalId ? "Pause" : "Start";
  });
}

function stopDemo() {
  window.clearInterval(intervalId);
  intervalId = undefined;
  renderDemo();
}

function startDemo() {
  stopDemo();
  intervalId = window.setInterval(() => {
    if (remaining <= 1) {
      remaining = 0;
      stopDemo();
      return;
    }
    remaining -= 1;
    renderDemo();
  }, 1000);
  renderDemo();
}

function loadWorkout(workout) {
  stopDemo();
  exercises = workout.exercises;
  planTitle.textContent = workout.title;
  durationBadge.textContent = workout.duration;
  whyText.textContent = workout.why;
  activeIndex = 0;
  remaining = exercises[0].seconds;
  buildWorkoutRows();
  renderDemo();
}

async function fetchWorkout() {
  appShell.classList.add("loading");
  refreshBtn.disabled = true;
  try {
    const res = await fetch(`/api/workout?t=${Date.now()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    loadWorkout(data);
  } catch (err) {
    console.error("fetchWorkout failed:", err.message);
    loadWorkout(FALLBACK_WORKOUT);
  } finally {
    appShell.classList.remove("loading");
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", fetchWorkout);

waitlistForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value.trim();
  formStatus.textContent = `${email} is on the Coreon waitlist.`;
  waitlistForm.reset();
});

fetchWorkout();
