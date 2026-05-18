// Re-export shell — the implementation lives in ./activity/. This file keeps
// the existing import path (`./task-detail/Activity`) working for callers
// like TaskDetailDrawer while the bulk of the code lives in granular sibling
// files.
export { ActivityTab } from './activity/ActivityTab';
export { CommentsThread } from './activity/CommentsThread';
export { CommentReactionsRow } from './activity/CommentReactionsRow';
export { RevisionHistoryModal } from './activity/RevisionHistoryModal';
export { ActivitySection } from './activity/ActivitySection';
