import { useLocation } from 'react-router-dom';

/**
 * PageTransition — CSS-only route crossfade.
 *
 * Wraps the routed content so each navigation triggers a 240ms opacity + Y
 * slide-in. Keyed by the first 3 path segments so navigating between sub-
 * routes inside the same surface (e.g. /projects/:id/board?task=X) doesn't
 * replay the transition when the drawer opens.
 *
 * The `.page-fade` class + `nockta-page-in` keyframe live in
 * `packages/ui/src/styles.css`. The keyframe respects `prefers-reduced-motion`
 * via the global `@media (prefers-reduced-motion: reduce)` rule that strips
 * all custom animations elsewhere in the stylesheet.
 *
 * R9 bundle-shrink note: this used to be a framer-motion `<AnimatePresence>`
 * mounted in the shell. Replacing it with the CSS class removes
 * `framer-motion` from the initial bundle entirely (~80KB gzipped saved).
 */
export function PageTransition({ children }: { children: React.ReactNode }): JSX.Element {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean).slice(0, 3);
  const key = segments.join('/') || 'root';

  // The `key` prop forces React to unmount + remount the div on route change,
  // which restarts the CSS animation. `h-full` keeps the routed surface
  // claiming the full viewport height like the framer-motion version did.
  return (
    <div key={key} className="page-fade h-full">
      {children}
    </div>
  );
}
