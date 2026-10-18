/**
 * Zero-dependency language hint for a prompt.
 *
 * This is a *hint*, not a full NLP pipeline. It detects a small set of
 * languages that prompt-gate users are likely to write in (Vietnamese,
 * English, Japanese, Chinese, Korean) by scanning for language-specific
 * characters or common function words. If nothing is detected we fall
 * back to "unknown" — in that case the meta-prompt preserves whatever
 * language the LLM thinks the prompt is in.
 *
 * We intentionally keep this conservative:
 * - Only emit a language when we have at least one strong signal.
 * - Vietnamese is detected by the presence of Latin letters with
 *   diacritics (à, á, ă, â, e, ê, i, o, ô, u, ư, plus tone marks).
 * - CJK is detected by character ranges, not by word lists.
 */

export type DetectedLanguage =
  | 'vietnamese'
  | 'english'
  | 'japanese'
  | 'chinese'
  | 'korean'
  | 'unknown';

interface LanguageSpec {
  id: DetectedLanguage;
  /** A single regex that matches strong signal characters/tokens. */
  signal: RegExp;
  /** Minimum number of matches required to call the language "detected". */
  minMatches: number;
}

// Vietnamese: any letter with a tone mark or diacritic.
// We intentionally EXCLUDE plain 'u', 'a', 'e', 'i', 'o' (too ambiguous with
// English) and keep only letters that are unambiguously Vietnamese diacritics
// (e.g. ư, ơ, ă, â, ơ, ơ, à, á, ả, ã, ă, ẹ, ế, ...).
const VIET_SIGNAL =
  /[àáạảãâầấẩẫăằắẳẵơờớởỡưừứửữựệếềểễỉíịọỏợỗởốộỳýỷýùú]/g;
// Japanese: Hiragana / Katakana (Kanji excluded so we don't collide with
// Chinese detection below; we rely on kana presence to label Japanese text).
const JAP_SIGNAL = /[\u3040-\u30ff]/g;
// Chinese: Han characters only.
const CHINESE_SIGNAL = /[\u4e00-\u9fff]/g;
// Korean: Hangul syllables.
const KOREAN_SIGNAL = /[\uac00-\ud7af]/g;
// English: common function words (word-bounded to avoid matching inside
// CJK / Vietnamese tokens).
const ENGLISH_SIGNAL = /\b(about|after|and|any|are|because|before|but|can|did|for|from|get|has|have|how|is|it|its|like|make|most|need|only|other|over|should|some|than|that|the|this|time|under|very|when|what|will|with|you|your)\b/g;

// Order matters: Vietnamese diacritics are checked FIRST because they are
// the strongest, unambiguous signal. Kana is checked before Han so Japanese
// text is labelled Japanese, not Chinese.
const SPECS: LanguageSpec[] = [
  { id: 'vietnamese', signal: VIET_SIGNAL, minMatches: 2 },
  { id: 'japanese', signal: JAP_SIGNAL, minMatches: 2 },
  { id: 'korean', signal: KOREAN_SIGNAL, minMatches: 2 },
  { id: 'chinese', signal: CHINESE_SIGNAL, minMatches: 2 },
  { id: 'english', signal: ENGLISH_SIGNAL, minMatches: 3 },
];

/**
 * Detect the language of a prompt using conservative heuristics.
 * Returns "unknown" when no signal is strong enough.
 */
export function detectLanguage(prompt: string): DetectedLanguage {
  const text = prompt.toLowerCase();

  // 1. Strong unambiguous signals first (character-based).
  for (const spec of SPECS) {
    if (spec.id === 'english') continue; // handled below
    const matches = text.match(spec.signal);
    if (matches && matches.length >= spec.minMatches) {
      return spec.id;
    }
  }

  // 2. English: word-based. Only treat as English when there is NO CJK /
  //    Hangul / Vietnamese-diacritic signal at all AND we have enough plain
  //    Latin words (function words or total word count >= 4). This keeps a
  //    short "abc def" from being mislabelled English.
  const hasForeignChars =
    /[à-ỹ\u0102\u02c6\u0300-\u036f]/.test(text) || // Vietnamese diacritics
    /[\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff]/.test(text); // CJK + Hangul + Kana
  if (hasForeignChars) return 'unknown';

  const words = text.split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
  const fnMatches = text.match(ENGLISH_SIGNAL) ?? [];
  if (fnMatches.length >= 2 || words.length >= 3) {
    return 'english';
  }
  return 'unknown';
}

/**
 * Render a language as the word we feed to the meta-prompt.
 * "unknown" is rendered as a no-op instruction.
 */
export function languageHint(id: DetectedLanguage): string {
  switch (id) {
    case 'vietnamese':
      return 'Vietnamese';
    case 'english':
      return 'English';
    case 'japanese':
      return 'Japanese';
    case 'chinese':
      return 'Chinese (Simplified, Mandarin)';
    case 'korean':
      return 'Korean';
    default:
      return 'the original language of the prompt';
  }
}
