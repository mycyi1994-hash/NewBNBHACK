/**
 * UI strings, keyed exactly as in docs/UX_COPY.md. Only keys used by a rendered screen live here;
 * the full KR/EN catalogue and language toggle arrive with M2-05.
 */
export const copy = {
  'home.title': {
    ko: '이자로 주식을 삽니다',
    en: 'Interest buys the stock.',
  },
  'home.sub': {
    ko: '원금은 그대로 두고, 이자로만 미국 주식을 조금씩 모아요.',
    en: 'Your principal stays put. Only the interest buys US stocks.',
  },
} as const satisfies Record<string, { ko: string; en: string }>;

export type CopyKey = keyof typeof copy;
