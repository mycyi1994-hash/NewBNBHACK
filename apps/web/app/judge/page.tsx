/**
 * /judge — the Judge Mode address in the README and the submission — now lives on the Invest tab.
 * The redirect keeps every shared link working.
 */
import { redirect } from 'next/navigation';

export default function JudgePage() {
  redirect('/invest');
}
