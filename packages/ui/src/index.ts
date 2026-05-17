// =============================================================================
// @nockta/ui — shared component layer + design tokens.
// Import the stylesheet once at the app root:
//   import '@nockta/ui/styles.css';
// =============================================================================

export * from './lib/cn';
export {
  NocktaMark,
  NocktaIcon,
  NocktaLogo,
  NocktaLockup,
  NocktaWordmark,
} from './components/NocktaMark';

// Shared primitives — both apps/web and apps/client should migrate raw
// HTML usages to these so theme + behavior stay coherent across surfaces.
export { Button, type ButtonProps } from './components/Button';
export { Input, type InputProps } from './components/Input';
export { Badge, type BadgeProps } from './components/Badge';
export { Avatar, type AvatarProps } from './components/Avatar';
export {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
} from './components/Card';

// Loading / empty / error primitives — apps use these to lift the floor on
// every data-fetch surface (replaces ad-hoc "Loading…" muted text + silent
// empty fallbacks).
export { Skeleton, SkeletonList } from './components/Skeleton';
export { EmptyState } from './components/EmptyState';
export { QueryErrorState } from './components/QueryErrorState';
export { Spinner } from './components/Spinner';
