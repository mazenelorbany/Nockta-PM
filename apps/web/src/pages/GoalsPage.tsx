import { useParams } from 'react-router-dom';
import { GoalDetailView } from './goals/GoalDetailView';
import { GoalListView } from './goals/GoalListView';

// =============================================================================
// GoalsPage — top-level router for the /goals area. Either renders the list
// view (when no :goalId) or the detail view for a specific goal. The actual
// implementations live in ./goals/ siblings.
// =============================================================================

export function GoalsPage(): JSX.Element {
  const { goalId } = useParams<{ goalId?: string }>();
  return goalId ? <GoalDetailView goalId={goalId} /> : <GoalListView />;
}
