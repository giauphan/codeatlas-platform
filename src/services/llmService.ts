import { logger } from "../utils/logger.js";

/**
 * Local keyword-based dream extraction from conversation transcripts.
 * No external API needed — uses pattern matching and sentence analysis.
 * Each message segment (USER/ASSISTANT) is classified independently,
 * then deduplicated across the session.
 */
export async function summarizeConversationForDreams(
  transcript: string,
  provider: string,
  project: string,
  sessionId: string
): Promise<Array<{ memoryType: string; content: string; importance: number }> | null> {
  const segments = transcript.split(/\n\n---\n\n/);
  const dreams: Array<{ memoryType: string; content: string; importance: number }> = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    const roleMatch = segment.match(/^\[(USER|ASSISTANT)\]/);
    if (!roleMatch) continue;
    const role = roleMatch[1];
    const text = segment.replace(/^\[(USER|ASSISTANT)\]\n/, "").trim();
    if (!text || text.length < 30) continue;

    // Classify based on keyword patterns
    const lower = text.toLowerCase();

    // Split into sentences for finer-grained extraction
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 30);

    for (const sentence of sentences) {
      const sl = sentence.toLowerCase().trim();
      // Dedup: skip if content too similar to already extracted
      const key = sl.slice(0, 60);
      if (seen.has(key)) continue;

      let memoryType: string | null = null;
      let importance = 5;

      // MISTAKE: error/fail/bug/wrong patterns
      if (/\b(mistake|error|fail|bug|wrong|broken|crash|exception|regression|incorrect)\b/i.test(sl)) {
        memoryType = "MISTAKE";
        importance = /\b(critical|security|crash|data.loss|vulnerability)\b/i.test(sl) ? 8 : 6;
      }
      // PREFERENCE: user preferences and style
      else if (/\b(prefer|like|want|would rather|style|convention|standard|best practice)\b/i.test(sl)) {
        memoryType = "PREFERENCE";
        importance = 6;
      }
      // PATTERN: recurring structures and approaches
      else if (/\b(pattern|always|often|typically|recurring|whenever|common|standard way)\b/i.test(sl)) {
        memoryType = "PATTERN";
        importance = 6;
      }
      // FIX: fix/refactor/improve patterns
      else if (/\b(fix|refactor|optimize|improve|migrate|replace|upgrade)\b/i.test(sl)) {
        memoryType = "KNOWLEDGE";
        importance = 5;
      }
      // KNOWLEDGE: general learnings (only from assistant, not user).
      // Requires both minimum length AND information content — not just "assistant said something long".
      // Matches sentences containing code-related, architecture, or decision content.
      else if (
        role === "ASSISTANT" &&
        sl.length > 120 &&
        /\b(code|function|class|module|api|method|pattern|approach|architectur|solution|implement|use\s|because|reason|cause|root|fix|change|config|deploy|error|issue|problem|prefer|better|worse|instead|recommend|learn|found|discover|notice|understand|see\s|need|should|must|require|support|handle|process|manag|build|create|design|structur|dependenc|interface|service|component|system|framework|library|database|query|request|response|endpoint|route|middleware|schema|migrat|test|deploy|version|releas|update|optimize|refactor)\b/i.test(sl)
      ) {
        memoryType = "KNOWLEDGE";
        importance = 4;
      }

      if (memoryType) {
        seen.add(key);
        dreams.push({
          memoryType,
          content: sentence.trim().slice(0, 300),
          importance,
        });
      }
    }
  }

  // Limit to top 10 by importance
  dreams.sort((a, b) => b.importance - a.importance);
  const top = dreams.slice(0, 10);

  // Dedup near-duplicates (same memoryType + similar content start)
  const final: typeof dreams = [];
  const finalSeen = new Set<string>();
  for (const d of top) {
    const dk = `${d.memoryType}:${d.content.slice(0, 40)}`;
    if (finalSeen.has(dk)) continue;
    finalSeen.add(dk);
    final.push(d);
  }

  return final.length > 0 ? final : null;
}
