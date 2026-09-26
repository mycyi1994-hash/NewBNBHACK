/**
 * UX_COPY §5 in full (the /risk page and the yield-mode modal). The rate and the security score
 * appear only when the worker has recorded them; otherwise that sentence is left out, never guessed.
 */
import { translate, type CopyKey, type Lang, type Params } from '../lib/i18n/translate';

export function RiskText({
  lang,
  apy,
  score,
}: {
  lang: Lang;
  apy: string | null;
  score: string | null;
}) {
  const t = (key: CopyKey, params?: Params) => translate(lang, key, params);
  return (
    <div className="mt-3 flex flex-col gap-2 leading-relaxed">
      <p>{t('risk.intro')}</p>
      <ol className="flex list-decimal flex-col gap-1 pl-5">
        {(['risk.1', 'risk.2', 'risk.3', 'risk.4', 'risk.5'] as const).map((key) => (
          <li key={key}>{t(key, { apy, score })}</li>
        ))}
      </ol>
      <p className="font-medium">{t('risk.agree')}</p>
    </div>
  );
}
