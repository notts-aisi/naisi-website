import {
  newQuestionId,
  type FormQuestion,
} from "@/lib/firestore/events";

/**
 * Hardcoded starter templates for the signup form builder. An organizer picks
 * one when creating an event and then freely edits the resulting questions.
 *
 * These are seeds — once placed into the event they're owned by that event, so
 * editing a preset here doesn't retroactively change historical events.
 */
export type FormPreset = {
  id: string;
  label: string;
  description: string;
  build: () => FormQuestion[];
};

export const FORM_PRESETS: FormPreset[] = [
  {
    id: "burger",
    label: "Burger event",
    description: "Beef / chicken / vegetarian choice, allergies, notes.",
    build: () => [
      {
        id: newQuestionId(),
        type: "singleSelect",
        label: "Burger choice",
        required: true,
        options: ["Beef", "Chicken", "Vegetarian"],
      },
      {
        id: newQuestionId(),
        type: "dietaryAllergies",
        label: "Any allergies or dietary requirements?",
        required: false,
      },
      {
        id: newQuestionId(),
        type: "shortText",
        label: "Anything else we should know?",
        required: false,
        placeholder: "e.g. no onions, no pickles",
      },
    ],
  },
  {
    id: "pizza",
    label: "Pizza event",
    description: "Allergies and dietary needs first, then toppings to avoid.",
    build: () => [
      {
        id: newQuestionId(),
        type: "dietaryAllergies",
        label: "Any allergies or dietary requirements?",
        required: false,
      },
      {
        id: newQuestionId(),
        type: "multiSelect",
        label: "Any toppings you'd rather avoid?",
        required: false,
        options: [
          "Bacon / pork",
          "Olives",
          "Mushrooms",
          "Peppers",
          "Pineapple",
          "Anchovies",
        ],
        allowOther: true,
      },
    ],
  },
  {
    id: "genericDietary",
    label: "Generic dietary",
    description: "Open-ended — any dietary requirements?",
    build: () => [
      {
        id: newQuestionId(),
        type: "yesNo",
        label: "Any dietary requirements?",
        required: true,
      },
      {
        id: newQuestionId(),
        type: "longText",
        label: "If yes, please specify",
        required: false,
        placeholder: "e.g. vegan, halal, nut allergy…",
      },
    ],
  },
  {
    id: "none",
    label: "No food",
    description: "Just confirm attendance — no food questions.",
    build: () => [],
  },
];

export function presetById(id: string): FormPreset | undefined {
  return FORM_PRESETS.find((p) => p.id === id);
}
