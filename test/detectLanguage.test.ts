import { describe, it, expect } from 'vitest';
import { detectLanguage, languageHint } from '../src/rewrite/detectLanguage.js';

describe('detectLanguage', () => {
  it('detects Vietnamese prompts (diacritic signal)', () => {
    expect(detectLanguage('react 19 memo cách hoạt động')).toBe('vietnamese');
    expect(detectLanguage('sửa bug đăng nhập cho tôi')).toBe('vietnamese');
    expect(detectLanguage('hướng dẫn viết test unit')).toBe('vietnamese');
  });

  it('detects Vietnamese prompts written without diacritics (word signal)', () => {
    expect(detectLanguage('thong tin viet nam')).toBe('vietnamese');
    expect(detectLanguage('sua loi dang nhap giup toi')).toBe('vietnamese');
    expect(detectLanguage('tom tat tin tuc hom nay')).toBe('vietnamese');
  });

  it('detects English prompts (word-count / function-word signal)', () => {
    expect(detectLanguage('fix the login bug in src/auth/login.ts')).toBe('english');
    expect(detectLanguage('please help me understand memoization')).toBe('english');
    expect(detectLanguage('please explain memoization')).toBe('english');
  });

  it('detects Japanese prompts (kana signal)', () => {
    expect(detectLanguage('メモ化の仕組みを説明して')).toBe('japanese');
  });

  it('detects Korean prompts (hangul signal)', () => {
    expect(detectLanguage('메모화 설명해줘')).toBe('korean');
  });

  it('detects Chinese prompts (han signal)', () => {
    expect(detectLanguage('请解释一下记忆化的原理')).toBe('chinese');
  });

  it('returns unknown for prompts with no strong signal', () => {
    expect(detectLanguage('abc def')).toBe('unknown');
    expect(detectLanguage('123 456 789')).toBe('unknown');
    expect(detectLanguage('fix bug')).toBe('unknown'); // 2 words, too short to call English
  });

  it('requires min matches to avoid false positives', () => {
    // One Vietnamese diacritic is not enough.
    expect(detectLanguage('ab ca')).toBe('unknown');
    // A single borrowed word ("tin") is not enough to call it Vietnamese.
    expect(detectLanguage('how to remove rust from a tin can')).toBe('english');
  });
});

describe('languageHint', () => {
  it('maps detected ids to prompt-friendly names', () => {
    expect(languageHint('vietnamese')).toBe('Vietnamese');
    expect(languageHint('english')).toBe('English');
    expect(languageHint('japanese')).toBe('Japanese');
    expect(languageHint('chinese')).toBe('Chinese (Simplified, Mandarin)');
    expect(languageHint('korean')).toBe('Korean');
    expect(languageHint('unknown')).toBe('the original language of the prompt');
  });
});
