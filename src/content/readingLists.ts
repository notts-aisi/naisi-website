/**
 * Curated reading lists surfaced on the public homepage and (eventually)
 * the /resources page. Sourced from the NAISI Notion's intro pages, with
 * the picks pruned to a tight three or four per list so the homepage stays
 * scannable. Add more entries here when /resources gets its own design pass;
 * the homepage component takes the first N of each list.
 *
 * Voice: descriptions are short and editorial, written from the position of
 * a NAISI committee member recommending the link to a curious student.
 * Avoid marketing voice. Prefer specifics.
 */

export type ReadingItem = {
  title: string;
  href: string;
  /**
   * Editorial blurb shown beneath the link on the homepage. One short
   * sentence, lowercase journalistic tone. Optional only because some links
   * are self-explanatory titles.
   */
  blurb?: string;
  /** Author or publisher line, used in small grey text. */
  source?: string;
};

export type ReadingList = {
  /** Slug used as a stable key; not URL-bound. */
  slug: string;
  /** Section heading on the homepage. */
  title: string;
  /** One-line framing under the heading. */
  blurb: string;
  items: ReadingItem[];
};

export const READING_LISTS: ReadingList[] = [
  {
    slug: "why-safe-ai",
    title: "If you want to know why this matters",
    blurb:
      "Four primers on what people in the field worry about and why. None of them assume you've thought about AI risk before.",
    items: [
      {
        title: "AI 2027",
        href: "https://ai-2027.com/",
        source: "Daniel Kokotajlo et al.",
        blurb:
          "A scenario-style year-by-year forecast for the next two years of frontier AI. Worth reading even if you disagree with the timeline.",
      },
      {
        title: "Risks from power-seeking AI",
        href: "https://80000hours.org/problem-profiles/risks-from-power-seeking-ai/",
        source: "80,000 Hours problem profile",
        blurb:
          "The standard primer on why misaligned AI could be a civilisational-scale risk. Long, careful, and actually argued.",
      },
      {
        title: "AI risks that could lead to catastrophe",
        href: "https://safe.ai/ai-risk",
        source: "Center for AI Safety",
        blurb:
          "A taxonomy of the failure modes researchers actually take seriously, with citations.",
      },
      {
        title: "Situational awareness: the decade ahead",
        href: "https://situational-awareness.ai/",
        source: "Leopold Aschenbrenner",
        blurb:
          "An insider's view of where AI capabilities are heading. Strong views, well argued.",
      },
    ],
  },
  {
    slug: "technical-basics",
    title: "If you want the technical basics",
    blurb:
      "How modern ML actually works, at a level deep enough to read alignment papers and shallow enough to start this week.",
    items: [
      {
        title: "But what is a neural network?",
        href: "https://www.youtube.com/watch?v=aircAruvnKk",
        source: "3Blue1Brown",
        blurb:
          "Visual intuition for what a neural network is doing. The whole four-part series is worth your evening.",
      },
      {
        title: "A short introduction to machine learning",
        href: "https://www.alignmentforum.org/posts/qE73pqxAZmeACsAdF/a-short-introduction-to-machine-learning",
        source: "AI Alignment Forum",
        blurb:
          "Reads in twenty minutes. Covers enough to follow most modern alignment writing.",
      },
      {
        title: "Intro to large language models",
        href: "https://www.youtube.com/watch?v=zjkBMFhNj_g",
        source: "Andrej Karpathy",
        blurb:
          "An hour of unhurried explanation by someone who has built them. Watch this before reading any LLM-safety paper.",
      },
      {
        title: "The bitter lesson",
        href: "http://www.incompleteideas.net/IncIdeas/BitterLesson.html",
        source: "Rich Sutton",
        blurb:
          "One short essay about why scaling has won, repeatedly. Useful frame for thinking about what's coming.",
      },
    ],
  },
  {
    slug: "overview-of-ai-safety",
    title: "If you want to understand the field",
    blurb:
      "Once the basics make sense, here's how to map the actual sub-disciplines people work in.",
    items: [
      {
        title: "First principles of AGI safety",
        href: "https://www.youtube.com/watch?v=DxwXLCQY1ns",
        source: "Richard Ngo",
        blurb:
          "Talk-format introduction to the structure of the technical alignment problem. The reference framing.",
      },
      {
        title: "Why AI alignment could be hard with modern deep learning",
        href: "https://www.cold-takes.com/why-ai-alignment-could-be-hard-with-modern-deep-learning/",
        source: "Holden Karnofsky",
        blurb:
          "Walks through the specific reasons aligning a deep-learning system is harder than aligning, say, a chess engine.",
      },
      {
        title: "Zoom in: an introduction to circuits",
        href: "https://distill.pub/2020/circuits/zoom-in/",
        source: "Distill",
        blurb:
          "The opening of mechanistic interpretability as a real research programme. Gorgeously written.",
      },
      {
        title: "How Claude 4 thinks",
        href: "https://www.dwarkesh.com/p/sholto-trenton-2",
        source: "Dwarkesh Patel with Sholto Douglas and Trenton Bricken",
        blurb:
          "Long-form interview about what's actually inside a frontier model right now. Candid and detailed.",
      },
    ],
  },
  {
    slug: "structured-courses",
    title: "If you want a structured course",
    blurb:
      "When you're done with primers and want to commit to weeks of work, these are the courses we ourselves point fellows at.",
    items: [
      {
        title: "AI Safety Fundamentals: Alignment",
        href: "https://course.aisafetyfundamentals.com/alignment",
        source: "BlueDot Impact",
        blurb:
          "The technical-stream curriculum. Free, run in cohorts, with reading and weekly facilitated discussion.",
      },
      {
        title: "AI Safety Fundamentals: Governance",
        href: "https://course.aisafetyfundamentals.com/governance",
        source: "BlueDot Impact",
        blurb:
          "The governance-stream counterpart. Policy frameworks, deployment-time risks, and the regulatory landscape.",
      },
      {
        title: "ARENA",
        href: "https://www.arena.education/",
        source: "Alignment Research Engineer Accelerator",
        blurb:
          "A hands-on technical curriculum. PyTorch, transformers, RLHF, interpretability, agents. Substantial commitment.",
      },
      {
        title: "AI Safety, Ethics and Society",
        href: "https://www.aisafetybook.com/",
        source: "Dan Hendrycks",
        blurb:
          "A free textbook covering the full surface of the field. Use it as a reference when other reading raises questions you can't place.",
      },
    ],
  },
];
