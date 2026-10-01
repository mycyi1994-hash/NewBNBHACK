'use client';
/**
 * The four tabs of the approved design (Overview · Earn · Invest · Activity): along the top on wide
 * screens, as a bottom bar with icons on phones. The yellow indicator slides to the active tab.
 * Pages outside the tabs light the tab they belong to (a plan is history, the assistant is investing).
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';
import { Icon, type IconName } from './Icon';
import { useNavIndicator } from './motion';

export type TabId = 'overview' | 'earn' | 'invest' | 'activity';

const TABS: { id: TabId; href: string; icon: IconName }[] = [
  { id: 'overview', href: '/', icon: 'home' },
  { id: 'earn', href: '/earn', icon: 'earn' },
  { id: 'invest', href: '/invest', icon: 'invest' },
  { id: 'activity', href: '/activity', icon: 'activity' },
];

export function activeTab(pathname: string): TabId | null {
  if (pathname === '/') return 'overview';
  const first = pathname.split('/')[1] ?? '';
  if (first === 'earn') return 'earn';
  if (['invest', 'judge', 'skill', 'check', 'compare'].includes(first)) return 'invest';
  if (first === 'activity' || first === 'plans') return 'activity';
  return null;
}

export function Nav({
  labels,
  ariaLabel,
  mobile = false,
}: {
  labels: Record<TabId, string>;
  ariaLabel: string;
  mobile?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const active = activeTab(usePathname());
  useNavIndicator(ref, active, mobile);
  return (
    <nav ref={ref} aria-label={ariaLabel} className={mobile ? 'mobile-nav' : 'desktop-nav'}>
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={active === tab.id ? 'active' : ''}
          aria-current={active === tab.id ? 'page' : undefined}
        >
          {mobile ? <Icon name={tab.icon} size={22} /> : null}
          <span>{labels[tab.id]}</span>
        </Link>
      ))}
      <i className="nav-indicator" aria-hidden="true" />
    </nav>
  );
}
