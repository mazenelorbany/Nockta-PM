import { useState } from 'react';

import { cn } from '../lib/cn';

/**
 * The Nockta N mark — angular SVG tracing of the brand's N glyph.
 * Falls back here if the AVIF asset isn't available (e.g. fresh checkout).
 */
export function NocktaMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      className={cn('inline-block h-[1em] w-[1em] flex-shrink-0', className)}
      aria-hidden="true"
    >
      <rect x="8" y="6" width="14" height="52" />
      <rect x="42" y="6" width="14" height="52" />
      <polygon points="8,6 22,6 56,58 42,58" />
    </svg>
  );
}

/**
 * The Nockta icon (the square N tile). Tries the AVIF asset that lives at
 * `/nockta-icon.avif` in the host app's public folder; falls back to the SVG
 * mark on a black tile if the image doesn't load.
 */
export function NocktaIcon({
  className,
  size = 32,
}: {
  className?: string;
  size?: number;
}): JSX.Element {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-[6px] bg-black text-brand',
          className,
        )}
        style={{ width: size, height: size, fontSize: size * 0.7 }}
      >
        <NocktaMark className="h-[0.95em] w-[0.95em]" />
      </span>
    );
  }

  return (
    <img
      src="/Nockta%20logo%20icon.avif"
      alt="Nockta"
      onError={() => setFailed(true)}
      className={cn('inline-block object-contain', className)}
      style={{ width: size, height: size }}
      width={size}
      height={size}
    />
  );
}

/**
 * The full Nockta wordmark image (icon + "NOCKTA"). Loads `/nockta-logo.avif`
 * from the host app's public folder. Falls back to a typeset lockup if the
 * asset isn't there yet.
 */
export function NocktaLogo({
  className,
  height = 28,
}: {
  className?: string;
  height?: number;
}): JSX.Element {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className={cn('inline-flex items-center gap-2', className)} style={{ height }}>
        <NocktaIcon size={height} />
        <span className="nockta-wordmark text-[0.95em] leading-none">Nockta</span>
      </span>
    );
  }

  return (
    <img
      src="/Nockta%20logo.avif"
      alt="Nockta"
      onError={() => setFailed(true)}
      className={cn('inline-block object-contain', className)}
      style={{ height, width: 'auto' }}
    />
  );
}

/**
 * Lockup — icon image + wordmark text. Useful when you want consistent
 * type sizing across the wordmark (the raster AVIF wordmark can't tint, so
 * this composes the raster icon with text-based "Nockta").
 */
export function NocktaLockup({
  className,
  variant = 'default',
  iconSize = 24,
}: {
  className?: string;
  /** `default` = light text on dark, `inverse` = dark text on light */
  variant?: 'default' | 'inverse';
  iconSize?: number;
}): JSX.Element {
  const wordmark = variant === 'inverse' ? 'text-black' : 'text-white';
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <NocktaIcon size={iconSize} />
      <span className={cn('nockta-wordmark text-[1em] leading-none', wordmark)}>Nockta</span>
    </span>
  );
}

/** Legacy alias kept for compatibility with older imports. */
export function NocktaWordmark({ className }: { className?: string }): JSX.Element {
  return <NocktaLogo {...(className ? { className } : {})} />;
}
