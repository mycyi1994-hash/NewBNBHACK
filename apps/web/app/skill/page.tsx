/**
 * /skill (DESIGN_BRIEF §5.4) in the approved design: hand the plan to your own AI assistant. Our
 * server decides; the user's Binance Agentic Wallet signs on their device (DECISIONS D-03). The
 * install line is the real one for Claude Code (a personal skill under ~/.claude/skills).
 */
import { ERC8004_REGISTRY_BSC } from '@yieldvest/chain';
import type { Metadata } from 'next';
import Link from 'next/link';
import { REPO_URL } from '../../components/Footer';
import { Icon } from '../../components/Icon';
import { Toolbar } from '../../components/Toolbar';
import { BlockTitle, Panel, SectionHeading } from '../../components/ui';
import { locale } from '../../lib/i18n/server';
import { context } from '../../lib/server/context';
import { TOOLS } from '../../lib/server/mcp';

const INSTALL = `git clone --depth 1 ${REPO_URL} yieldvest-src && mkdir -p ~/.claude/skills && cp -r yieldvest-src/skills/yieldvest ~/.claude/skills/`;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await locale();
  return { title: t('nav.skill') };
}

export default async function SkillPage() {
  const { lang, tz, t } = await locale();
  const { appUrl, agent } = context().config;
  const dialogue = [
    { who: 'me', key: 'skill.example.1' },
    { who: 'assistant', key: 'skill.example.2' },
    { who: 'assistant', key: 'skill.example.3' },
    { who: 'me', key: 'skill.example.4' },
    { who: 'assistant', key: 'skill.example.5' },
  ] as const;
  return (
    <>
      <Toolbar t={t} lang={lang} tz={tz} title={t('skill.title')} />
      <div className="workspace-grid">
        <section className="visual-workspace">
          <SectionHeading title={t('skill.note')} />
          <ol className="demo-steps page-steps">
            {(['skill.step1', 'skill.step2', 'skill.step3'] as const).map((key, i) => (
              <li key={key}>
                <span>{i + 1}</span>
                <div>
                  <strong>{t(key)}</strong>
                  {key === 'skill.step2' ? (
                    <>
                      <p>{t('skill.install.label')}</p>
                      <pre className="code-box">
                        <code>{INSTALL}</code>
                      </pre>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <div className="page-block">
            <BlockTitle>{t('mcp.title')}</BlockTitle>
            <p>{t('mcp.body')}</p>
            <p className="field-label mcp-label">{t('mcp.install.label')}</p>
            <pre className="code-box">
              <code>{`claude mcp add --transport http yieldvest ${new URL('/api/mcp', appUrl).href}`}</code>
            </pre>
            <p className="method-note">
              {t('mcp.tools', { tools: TOOLS.map((tool) => tool.name).join(', ') })}
            </p>
            <Link className="text-link mcp-label" href="/wallet">
              {t('wallet.link')}
              <Icon name="arrow" size={16} />
            </Link>
            {/* The ERC-8004 identity (D-33): the file always; the id only once it is registered. */}
            <p className="method-note agent-identity">
              <a className="text-link" href="/api/agent">
                {t('agent.card')}
              </a>
              {agent.id ? (
                <>
                  {' · '}
                  <a
                    className="text-link"
                    href={`https://bscscan.com/token/${ERC8004_REGISTRY_BSC}?a=${agent.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('agent.registered', { id: agent.id })}
                  </a>
                </>
              ) : null}
            </p>
          </div>
          <div className="page-block">
            <BlockTitle>{t('skill.example.title')}</BlockTitle>
            <div className="chat">
              {dialogue.map((line) => (
                <div key={line.key} className={`bubble ${line.who}`}>
                  <small>
                    {t(line.who === 'me' ? 'skill.example.me' : 'skill.example.assistant')}
                  </small>
                  {t(line.key)}
                </div>
              ))}
            </div>
          </div>
        </section>
        <Panel eyebrow={t('nav.skill')} title={t('skill.rules.title')}>
          <ul className="check-list">
            {(
              [
                'skill.rules.1',
                'skill.rules.2',
                'skill.rules.3',
                'skill.rules.4',
                'skill.rules.5',
              ] as const
            ).map((key) => (
              <li key={key}>
                <Icon name="check" size={18} />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
          <p className="panel-note">{t('skill.step3')}</p>
          <a className="button dark wide" href="/api/openapi">
            {t('skill.api')}
            <Icon name="arrow" size={18} />
          </a>
        </Panel>
      </div>
    </>
  );
}
