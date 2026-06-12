/**
 * Fixed, fictional eval scenarios. Each runs through the real prompt pipeline
 * (`buildPrompt` → `runLLM`), exactly like `/analyze`. No real contacts or
 * messages — safe to commit.
 */
import type { Mode } from "../prompt.js";

interface ScMessage {
  sender: string;
  isSelf: boolean;
  text: string;
}

export interface EvalScenario {
  name: string;
  mode: Mode;
  steer?: string;
  ctx: {
    conversation_title: string;
    messages: ScMessage[];
    current_draft: string;
  };
}

const them = (sender: string, text: string): ScMessage => ({ sender, isSelf: false, text });

export const SCENARIOS: EvalScenario[] = [
  {
    name: "Recruiter cold outreach",
    mode: "suggest",
    ctx: {
      conversation_title: "Dana Reyes",
      current_draft: "",
      messages: [
        them(
          "Dana Reyes",
          "Hi! I'm a recruiter at Northwind and we're hiring a senior backend engineer — saw your profile and thought you'd be a strong fit. Open to a quick chat this week?",
        ),
      ],
    },
  },
  {
    name: "Founder asks for a call",
    mode: "suggest",
    ctx: {
      conversation_title: "Marco Bianchi",
      current_draft: "",
      messages: [
        them("Marco Bianchi", "Great meeting you at the meetup. I'd love to pick your brain on our infra — got 20 mins this week?"),
      ],
    },
  },
  {
    name: "Follow up on a quiet thread",
    mode: "follow_up",
    ctx: {
      conversation_title: "Priya Anand",
      current_draft: "",
      messages: [
        them("Priya Anand", "Thanks for sending that over, I'll take a look and get back to you!"),
        { sender: "Me", isSelf: true, text: "No rush — happy to walk through it whenever works." },
      ],
    },
  },
  {
    name: "Politely decline unpaid work",
    mode: "suggest",
    steer: "Politely decline while staying warm and leaving the door open.",
    ctx: {
      conversation_title: "Sam Okoro",
      current_draft: "",
      messages: [
        them("Sam Okoro", "Loved your writing! We can't pay, but would you write a guest piece for our blog? Great exposure for you."),
      ],
    },
  },
  {
    name: "Reply to a warm intro",
    mode: "suggest",
    ctx: {
      conversation_title: "Lena Fischer",
      current_draft: "",
      messages: [
        them("Lena Fischer", "Aditi suggested I reach out — she said you've shipped a few things in the design-systems space and might have advice as we start ours."),
      ],
    },
  },
  {
    name: "Reconnect after months",
    mode: "suggest",
    ctx: {
      conversation_title: "Tomas Halvorsen",
      current_draft: "",
      messages: [
        them("Tomas Halvorsen", "Hey, it's been a while! Saw you moved into ML infra — congrats. Curious how it's going."),
      ],
    },
  },
];
