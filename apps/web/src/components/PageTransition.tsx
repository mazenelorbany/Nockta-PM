import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useLocation } from 'react-router-dom';

/**
 * Animates route changes. Wrap the <Outlet /> (or whatever holds the routed
 * page content) so each navigation gets a brief opacity + Y slide.
 *
 * Asymmetric timing per Emil — incoming is the deliberate motion (240ms),
 * outgoing is fast and quiet (140ms) so back/forward feels responsive.
 *
 * Respects prefers-reduced-motion: just opacity, no translate.
 */
export function PageTransition({ children }: { children: React.ReactNode }): JSX.Element {
  const location = useLocation();
  const reduce = useReducedMotion();

  // Key off the first 3 path segments so navigating between subroutes inside
  // the same surface (e.g. /projects/:id/board?task=X) doesn't replay the
  // transition every time the drawer opens.
  const segments = location.pathname.split('/').filter(Boolean).slice(0, 3);
  const key = segments.join('/') || 'root';

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={key}
        initial={{ opacity: 0, y: reduce ? 0 : 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reduce ? 0 : -4 }}
        transition={{
          duration: 0.24,
          ease: [0.23, 1, 0.32, 1],
          opacity: { duration: 0.18 },
        }}
        className="h-full"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
