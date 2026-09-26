/**
 * /skill (DESIGN_BRIEF §5.4): hand the plan to your own AI assistant. Our server decides; the
 * user's Binance Agentic Wallet signs on their device (DECISIONS D-03). The install line is the
 * real one for Claude Code (a personal skill under ~/.claude/skills).
 */
import { Card, SectionTitle } from '../../components/ui';
import { REPO_URL } from '../../components/Footer';
import { locale } from '../../lib/i18n/server';

const INSTALL = `git clone --depth 1 ${REPO_URL} ijaro-src && mkdir -p ~/.claude/skills && cp -r ijaro-src/skills/ijaro ~/.claude/skills/`;

export default async function SkillPage() {
  const { t } = await locale();
  const dialogue = [
    { who: 'me', key: 'skill.example.1' },
    { who: 'assistant', key: 'skill.example.2' },
    { who: 'assistant', key: 'skill.example.3' },
    { who: 'me', key: 'skill.example.4' },
    { who: 'assistant', key: 'skill.example.5' },
  ] as const;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-3xl font-extrabold">{t('skill.title')}</h1>
      <ol className="flex flex-col gap-3">
        {(['skill.step1', 'skill.step2', 'skill.step3'] as const).map((key, i) => (
          <li key={key}>
            <Card className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand font-bold text-white">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t(key)}</p>
                {key === 'skill.step2' ? (
                  <div className="mt-3">
                    <div className="text-xs font-semibold text-muted">
                      {t('skill.install.label')}
                    </div>
                    <pre className="mt-1 overflow-x-auto rounded-xl bg-ink p-3 text-sm text-white">
                      <code>{INSTALL}</code>
                    </pre>
                  </div>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ol>
      <p className="rounded-xl bg-brand-soft px-4 py-3 font-medium text-ok">{t('skill.note')}</p>

      <section>
        <SectionTitle>{t('skill.example.title')}</SectionTitle>
        <div className="flex flex-col gap-2">
          {dialogue.map((line) => (
            <div
              key={line.key}
              className={`max-w-[85%] rounded-2xl px-4 py-2 ${
                line.who === 'me'
                  ? 'self-end bg-brand text-white'
                  : 'self-start border border-line bg-white'
              }`}
            >
              <div className="text-xs opacity-80">
                {t(line.who === 'me' ? 'skill.example.me' : 'skill.example.assistant')}
              </div>
              {t(line.key)}
            </div>
          ))}
        </div>
      </section>

      <Card>
        <SectionTitle>{t('skill.rules.title')}</SectionTitle>
        <ul className="flex flex-col gap-2">
          {(
            [
              'skill.rules.1',
              'skill.rules.2',
              'skill.rules.3',
              'skill.rules.4',
              'skill.rules.5',
            ] as const
          ).map((key) => (
            <li key={key} className="flex gap-2">
              <span aria-hidden="true" className="text-brand">
                ✓
              </span>
              {t(key)}
            </li>
          ))}
        </ul>
      </Card>
      <a href="/api/openapi" className="font-medium text-brand hover:underline">
        {t('skill.api')} ↗
      </a>
    </div>
  );
}
