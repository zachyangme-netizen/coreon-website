import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SYSTEM_PROMPT = `You generate workout demo data for Coreon, a strength-training app for runners.

Return ONLY a valid JSON object — no markdown, no code fences, no explanation. The schema:
{
  "title": "Short workout name (e.g. 'Post-run reset', 'Core stability', 'Hip mobility')",
  "duration": "Total time as string (e.g. '18 min', '24 min', '30 min')",
  "exercises": [
    { "name": "Exercise name", "seconds": <number between 60 and 180> }
  ],
  "why": "1–2 sentences explaining why this workout makes sense today, written as if the AI knows the user's recent runs."
}

Rules:
- Include 4–6 exercises per workout
- Vary the workout type on each call: choose one of post-run recovery, strength building, hip mobility, core stability, or running endurance
- Exercise names should sound like a real fitness app (descriptive, not generic)
- "why" should sound like intelligent AI reasoning about the runner's training load and recovery state`;

const FALLBACK = {
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

export default async function handler(req, res) {
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "Generate a workout for today." }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const workout = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(workout);
  } catch (err) {
    console.error("Workout generation failed:", err);
    res.status(200).json(FALLBACK);
  }
}
