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
 * - Vietnamese is detected by (a) Latin letters with diacritics
 *   (à, á, ă, â, e, ê, i, o, ô, u, ư, plus tone marks), or (b) a curated list
 *   of unaccented function words ("khong", "duoc", "giup", ...) for users who
 *   type without tone marks / on an ASCII keyboard.
 * - CJK is detected by character ranges, not by word lists.
 */

export type DetectedLanguage = 'vietnamese' | 'english' | 'japanese' | 'chinese' | 'korean' | 'unknown';

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
const VIET_SIGNAL = /[àáạảãâầấẩẫăằắẳẵơờớởỡưừứửữựệếềểễỉíịọỏợỗởốộỳýỷýùú]/g;
// Japanese: Hiragana / Katakana (Kanji excluded so we don't collide with
// Chinese detection below; we rely on kana presence to label Japanese text).
const JAP_SIGNAL = /[\u3040-\u30ff]/g;
// Chinese: Han characters only.
const CHINESE_SIGNAL = /[\u4e00-\u9fff]/g;
// Korean: Hangul syllables.
const KOREAN_SIGNAL = /[\uac00-\ud7af]/g;
// English: common function words (word-bounded to avoid matching inside
// CJK / Vietnamese tokens).
const ENGLISH_SIGNAL =
  /\b(about|after|and|any|are|because|before|but|can|did|for|from|get|has|have|how|is|it|its|like|make|most|need|only|other|over|should|some|than|that|the|this|time|under|very|when|what|will|with|you|your)\b/g;
// Vietnamese typed WITHOUT diacritics (fast typing / ASCII keyboard), e.g.
// "sua loi dang nhap giup toi". Curated function words: common English words
// ("the", "can", "do", "an", "ban", ...) are intentionally EXCLUDED, and two
// hits are required, so a single borrowed word ("tin", "mot", "rat") cannot
// flip an English prompt to Vietnamese.
const VIET_WORDS_SIGNAL =
  /\b(khong|duoc|nhung|nguoi|cua|cho|trong|khi|nay|thi|neu|rat|voi|toi|cac|mot|hai|giup|viet|sua|xem|tim|lam|giai|thich|cach|hoat|tat|hom|tuc|tin|thong|nam|tam|sau|truoc|len|xuong|vao|hoc|ngu|uong|chao|xin|thay|biet|muon|loi|nhap|huong|noi|nhu|theo|dang|sao|nao|minh|chung|cung)\b/g;

// Order matters: Vietnamese diacritics are checked FIRST because they are
// the strongest, unambiguous signal. Kana is checked before Han so Japanese
// text is labelled Japanese, not Chinese.
const SPECS: LanguageSpec[] = [
  { id: 'vietnamese', signal: VIET_SIGNAL, minMatches: 2 },
  // Same language, second signal: Vietnamese typed without diacritics.
  { id: 'vietnamese', signal: VIET_WORDS_SIGNAL, minMatches: 2 },
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
  //    Hangul / Vietnamese (diacritic or unaccented-word) signal at all AND we
  //    have enough plain Latin words (function words or total word count
  //    >= 3). This keeps a short "abc def" from being mislabelled English.
  const hasForeignChars =
    // eslint-disable-next-line no-misleading-character-class -- combined diacritic ranges are intentional
    /[\u00E0-\u016F\u02C6-\u02CF\u0300-\u036F]/.test(text) || // Vietnamese diacritics
    /[\u4E00-\u9FFF\uAC00-\uD7A3\u3040-\u30FF]/.test(text); // CJK + Hangul + Kana
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
