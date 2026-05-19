// Re-export shell — the implementation lives in ./activity/. This file keeps
// the existing import path (`./task-detail/Activity`) working for callers
// like TaskDetailDrawer while the bulk of the code lives in granular sibling
// files.
export { ActivityTab } from './activity/ActivityTab';
export { CommentsThread } from './activity/CommentsThread';
export { ActivitySection } from './activity/ActivitySection';
