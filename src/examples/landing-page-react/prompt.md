# Few-shot Exemplar: Landing Page in React + Tailwind

## Prompt

> Build a single-page marketing site for a fictional dev tool called
> **Quill** with: hero, features grid (3 cards), pricing (3 tiers), FAQ
> (5 questions), and footer. Use React 18 + Vite + Tailwind v3. The hero
> should have a big headline, sub-headline, and two CTA buttons. Keep it
> responsive (mobile-first) and accessible (semantic HTML, ARIA labels,
> focus styles). No external CSS frameworks beyond Tailwind.

## Gold-standard output

```tsx
// src/App.tsx
import { useState } from 'react';
import Hero from './components/Hero';
import Features from './components/Features';
import Pricing from './components/Pricing';
import Faq from './components/Faq';
import Footer from './components/Footer';

export default function App() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      <Hero />
      <Features />
      <Pricing />
      <Faq />
      <Footer />
    </main>
  );
}
```

```tsx
// src/components/Hero.tsx
export default function Hero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="px-6 py-24 text-center sm:py-32 lg:py-40"
    >
      <h1
        id="hero-heading"
        className="text-4xl font-bold tracking-tight sm:text-6xl"
      >
        Ship docs, not dread.
      </h1>
      <p className="mx-auto mt-6 max-w-xl text-lg text-slate-600">
        Quill turns messy Markdown drafts into polished documentation
        with one command.
      </p>
      <div className="mt-10 flex justify-center gap-4">
        <a
          href="#pricing"
          className="rounded-md bg-slate-900 px-6 py-3 font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
        >
          Get started
        </a>
        <a
          href="#features"
          className="rounded-md border border-slate-300 px-6 py-3 font-medium hover:bg-slate-50"
        >
          Learn more
        </a>
      </div>
    </section>
  );
}
```

## Why this is the gold standard

- **Semantic HTML** (`<main>`, `<section aria-labelledby>`, `<h1>` with id).
- **Mobile-first Tailwind** (`px-6`, `sm:py-32`).
- **Accessible focus styles** (`focus:ring-2`).
- **No placeholder code** — every component is fully implemented.
- **No invented dependencies** — uses what's already in the repo.
