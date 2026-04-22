const exercises = [
  { name: "Hip flexor stretch", seconds: 120 },
  { name: "Glute bridge hold", seconds: 90 },
  { name: "Single-leg RDL", seconds: 150 },
  { name: "Dead bug", seconds: 120 },
  { name: "Child’s pose reset", seconds: 90 },
];

const rows = document.querySelectorAll(".workout-row");
const activeLabel = document.getElementById("active-label");
const timer = document.getElementById("timer");
const progressBar = document.getElementById("progress-bar");
const waitlistForm = document.getElementById("waitlist-form");
const formStatus = document.getElementById("form-status");

let activeIndex = 0;
let remaining = exercises[activeIndex].seconds;
let intervalId;

function formatTime(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function renderDemo() {
  const exercise = exercises[activeIndex];
  const elapsed = exercise.seconds - remaining;
  const progress = Math.round((elapsed / exercise.seconds) * 100);

  activeLabel.textContent = exercise.name;
  timer.textContent = formatTime(remaining);
  progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;

  rows.forEach((row, index) => {
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

rows.forEach((row, index) => {
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

waitlistForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value.trim();
  formStatus.textContent = `${email} is on the Coreon waitlist.`;
  waitlistForm.reset();
});

renderDemo();
