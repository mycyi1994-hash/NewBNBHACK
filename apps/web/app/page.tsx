import { copy } from '../lib/copy';

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-16">
      <h1 className="text-3xl font-bold">{copy['home.title'].ko}</h1>
      <p className="text-lg">{copy['home.sub'].ko}</p>
      <p className="text-sm text-neutral-500" lang="en">
        {copy['home.title'].en} {copy['home.sub'].en}
      </p>
    </main>
  );
}
