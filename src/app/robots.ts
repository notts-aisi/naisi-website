import type { MetadataRoute } from "next";

/*
  Public crawler policy. Default-allow for search engines, then a block list
  for known AI training crawlers. Honest crawlers respect this; bad actors
  ignore it (handle those at the edge if it ever matters).
*/
export default function robots(): MetadataRoute.Robots {
  const aiTrainingBots = [
    "GPTBot",
    "ChatGPT-User",
    "OAI-SearchBot",
    "ClaudeBot",
    "Claude-Web",
    "anthropic-ai",
    "CCBot",
    "PerplexityBot",
    "Perplexity-User",
    "Bytespider",
    "Google-Extended",
    "Applebot-Extended",
    "FacebookBot",
    "Meta-ExternalAgent",
    "Amazonbot",
    "Diffbot",
    "ImagesiftBot",
    "Omgilibot",
    "Omgili",
    "cohere-ai",
    "cohere-training-data-crawler",
    "AI2Bot",
    "Timpibot",
  ];

  return {
    rules: [
      // The offline fallback also carries a noindex meta, but belt and
      // braces: it is a contentless utility page.
      { userAgent: "*", allow: "/", disallow: "/offline.html" },
      { userAgent: aiTrainingBots, disallow: "/" },
    ],
  };
}
