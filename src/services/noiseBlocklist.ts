/**
 * Noise blocklist — two-layer gate for dream memories.
 *
 * save-gate:  dreamingService.checkNoise() rejects blocklisted dreams before
 *             they are embedded/persisted.
 * inject-gate: queryDreamMemories() and llmService.loadContextAtSessionStart()
 *             strip blocklisted dreams before they enter conversation context,
 *             so junk that already exists (or slipped past save-gate) never
 *             reaches the prompt.
 *
 * Patterns target low-information personal-life content that repeatedly
 * pollutes the second brain: English-study fragments, Vietnamese grammar
 * notes, shopping/grocery lists, weather/lifestyle scraps, and social-media
 * scheduler retry notes. Patterns are deliberately phrase-specific so genuine
 * code knowledge dreams are not caught.
 */

const NOISE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // English study / pronunciation notes
  [/\benglish\s*(lesson|stud|class|vocab|practice)\b/i, "english-study note"],
  [/\b(?:new|today(?:'s)?)?\s*(?:lesson|lession)\b/i, "english lesson note"],
  [/\bdùng\s+raining|\bwhen\s+(?:to\s+)?use\s+(?:raining|rainy|sunny)\b/i, "english word-choice note"],
  [/\btính\s+danh|\b(?:danh\s+từ|trạng\s+từ|động\s+từ)\b|\bsao\s+để\s+biết/i, "vietnamese grammar note"],
  [/\btiếng\s+anh\b|\btừ\s+vựng\b/i, "vietnamese study note"],
  [/\b(?:pronunci|spelling|how\s+to\s+pronounce)\b/i, "pronunciation note"],

  // Weather / seasonal personal notes
  [/\bweather\b|\brain(y|ing)\b|\bsunny\b/i, "weather note"],

  // Shopping / grocery / food lists
  [/\bshopping\s*list\b|\bgrocery\b|going\s+to\s+the\s+store\b/i, "shopping list"],
  [/\bbuy(?:ing)?\s+(?:bananas?|bread|milk|yog(?:h)?urt|chicken|fish|food|meat|cheese|rice|fruit|veggie|juice)\b/i, "grocery item"],
  [/\blow-fat\s+milk\b|\bplain\s+yogurt\b|\bone\s+list\s+to\s+rule\s+them\s+all\b/i, "food note"],

  // Lifestyle / habit scraps
  [/\bstay\s+at\s+home\b|\bmiss\s+breakfast\b|\brelax\s+by\s+reading\b|\bless\s+crowded\b|\bquiet\s+atmosphere\b|\bcharge[d]?\s+(?:my\s+)?phone\b|\bnot\s+to\s+act\b|\bsmart\s+goal\b|\bprocrastin/i, "lifestyle note"],

  // Social-media scheduler retry noise
  [/\b--retry-failed\b|\bstuck\s+.*\bscheduling\b|\bscheduling\s+records\b|\bretry\s+(?:the\s+)?(?:failed|failure)\b/i, "scheduler retry note"],

  // Interview / non-tech activity fragments
  [/\binterview\s+question/i, "interview note"],
  [/\btic\s*tac\s*toe\b|\bvision\s+test\b|\bbalance\s+test\b/i, "non-tech activity note"],

  // Degenerate / repeated content
  [/\bsame\s+(?:input|day[\s-]*day)\s+\w*\s*repeated\s+multiple\s+times\b/i, "degenerate repeated content"],
];

export interface NoiseBlockResult {
  isNoise: boolean;
  reason: string | null;
}

export function checkNoiseBlocklist(content: string): NoiseBlockResult {
  const normalized = content.trim();
  if (!normalized) {
    return { isNoise: false, reason: null };
  }
  const lower = normalized.toLowerCase();
  for (const [pattern, reason] of NOISE_PATTERNS) {
    if (pattern.test(lower)) {
      return { isNoise: true, reason: `blocklist: ${reason}` };
    }
  }
  return { isNoise: false, reason: null };
}