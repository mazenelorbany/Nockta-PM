import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';

// =============================================================================
// TaskDependencyGraph — interactive SVG of a task's blocker / linked-to
// neighborhood (Pass 5 R4-deferred C).
//
// Layout (BFS, no external deps):
//   - Focal task sits in column 0.
//   - Predecessors of focal (other.from=other, to=focal) go to column -1.
//   - Predecessors of those go to column -2.
//   - Successors (focal -> other) go to column +1, +2.
//   - Tasks at the same column are stacked vertically by BFS discovery order.
//
// Layout is deterministic — same {nodes, edges} input renders to the same
// SVG every time. That's important for screenshot tests and for not
// shifting the focus marker on every refetch.
//
// Interaction:
//   - Wheel zooms (0.5x .. 2x).
//   - Mouse drag on the SVG background pans.
//   - Clicking a node fires `onNodeClick(nodeId)` — caller can swap the
//     drawer to that task.
// =============================================================================

export interface GraphNode {
  id: string;
  key: string;
  title: string;
  status: string;
  projectId: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'blocks' | 'related' | 'duplicate';
}

export interface DependencyGraph {
  focalId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Pure layout helpers — exported separately so the test suite can assert on
// them without rendering React.
// ---------------------------------------------------------------------------

export interface LaidOutNode extends GraphNode {
  /** Negative = predecessor, 0 = focal, positive = successor. */
  column: number;
  /** Vertical slot within the column (0-indexed top to bottom). */
  row: number;
  /** Computed (x, y) in SVG coordinate space. */
  x: number;
  y: number;
}

export interface LaidOutGraph {
  focalId: string;
  nodes: LaidOutNode[];
  edges: GraphEdge[];
  /** Suggested SVG viewBox dimensions for the bounding render area. */
  width: number;
  height: number;
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;
const COLUMN_GAP = 90;
const ROW_GAP = 24;
const PADDING = 32;

/**
 * Walk the edge set forward from the focal id to assign columns. Predecessors
 * (edges `from -> focal`) go negative; successors (edges `focal -> to`) go
 * positive. Cycles short-circuit because we track `visited`.
 *
 * The algorithm is intentionally simple — for a depth-2 BFS budget the
 * largest input is ~50 nodes; any optimization beyond O(N*E) is wasted.
 */
export function layoutDependencyGraph(graph: DependencyGraph): LaidOutGraph {
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  if (!byId.has(graph.focalId)) {
    // Defensive: the focal node MUST exist in the node list. If the API
    // returns an inconsistent payload we still render an empty graph rather
    // than throw — calling code can detect by checking `nodes.length === 0`.
    return { focalId: graph.focalId, nodes: [], edges: graph.edges, width: PADDING * 2, height: PADDING * 2 };
  }

  // Adjacency maps. preds: id -> Set<predecessor ids>; succs: id -> Set<successor ids>.
  const preds = new Map<string, Set<string>>();
  const succs = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    preds.set(n.id, new Set());
    succs.set(n.id, new Set());
  }
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    succs.get(e.from)?.add(e.to);
    preds.get(e.to)?.add(e.from);
  }

  // BFS assigns each visited node to a column. A node may be reachable on
  // BOTH sides (predecessor of one neighbor and successor of another); the
  // first column assignment wins, which keeps the focal node centered.
  const columns = new Map<string, number>();
  columns.set(graph.focalId, 0);

  // Forward BFS (successors → positive columns).
  let frontier: string[] = [graph.focalId];
  for (let depth = 1; depth <= 4 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const targets = succs.get(id);
      if (!targets) continue;
      for (const t of targets) {
        if (columns.has(t)) continue;
        columns.set(t, depth);
        next.push(t);
      }
    }
    frontier = next;
  }
  // Backward BFS (predecessors → negative columns).
  frontier = [graph.focalId];
  for (let depth = 1; depth <= 4 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const sources = preds.get(id);
      if (!sources) continue;
      for (const s of sources) {
        if (columns.has(s)) continue;
        columns.set(s, -depth);
        next.push(s);
      }
    }
    frontier = next;
  }

  // Group by column for stacking.
  const byColumn = new Map<number, GraphNode[]>();
  for (const [id, col] of columns) {
    const n = byId.get(id);
    if (!n) continue;
    const list = byColumn.get(col) ?? [];
    list.push(n);
    byColumn.set(col, list);
  }
  // Stable sort within a column by key so identical input always renders the
  // same order — the implicit BFS order would be insertion-order-dependent.
  for (const list of byColumn.values()) {
    list.sort((a, b) => a.key.localeCompare(b.key));
  }

  // Pick the column extents to size the canvas.
  const minCol = Math.min(0, ...columns.values());
  const maxCol = Math.max(0, ...columns.values());
  const colCount = maxCol - minCol + 1;
  const tallestColumn = Math.max(...Array.from(byColumn.values()).map((l) => l.length));

  const width = PADDING * 2 + colCount * NODE_WIDTH + (colCount - 1) * COLUMN_GAP;
  const height = PADDING * 2 + tallestColumn * NODE_HEIGHT + (tallestColumn - 1) * ROW_GAP;

  const laidOut: LaidOutNode[] = [];
  for (const [col, list] of byColumn) {
    const xColumnIndex = col - minCol; // 0-indexed left-to-right
    const x = PADDING + xColumnIndex * (NODE_WIDTH + COLUMN_GAP);
    // Center the column vertically within the available height so columns
    // with fewer nodes don't all sit at the top.
    const colHeight = list.length * NODE_HEIGHT + (list.length - 1) * ROW_GAP;
    const yStart = (height - colHeight) / 2;
    for (let i = 0; i < list.length; i += 1) {
      const node = list[i];
      if (!node) continue;
      laidOut.push({
        ...node,
        column: col,
        row: i,
        x,
        y: yStart + i * (NODE_HEIGHT + ROW_GAP),
      });
    }
  }

  return {
    focalId: graph.focalId,
    nodes: laidOut,
    edges: graph.edges.filter((e) => columns.has(e.from) && columns.has(e.to)),
    width,
    height,
  };
}

/**
 * Pick a status color for the node body. The status strings are workflow-
 * preset-dependent (engineering vs design vs generic), so we match on
 * common prefixes / keywords rather than an exhaustive enum.
 */
export function statusColor(status: string): { fill: string; stroke: string } {
  const s = status.toLowerCase();
  if (s.includes('done') || s.includes('shipped') || s.includes('closed')) {
    return { fill: 'rgb(34 197 94 / 0.15)', stroke: 'rgb(34 197 94 / 0.6)' };
  }
  if (s.includes('block')) {
    return { fill: 'rgb(239 68 68 / 0.15)', stroke: 'rgb(239 68 68 / 0.6)' };
  }
  if (s.includes('progress') || s.includes('doing') || s.includes('review')) {
    return { fill: 'rgb(59 130 246 / 0.15)', stroke: 'rgb(59 130 246 / 0.6)' };
  }
  return { fill: 'rgb(148 163 184 / 0.15)', stroke: 'rgb(148 163 184 / 0.6)' };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TaskDependencyGraphProps {
  taskId: string;
  /** Override the data fetch — primarily for tests that pass a static graph. */
  data?: DependencyGraph;
  onNodeClick?: (nodeId: string) => void;
  /** Max BFS depth in each direction. Defaults to 2 per spec. */
  depth?: number;
}

export function TaskDependencyGraph({
  taskId,
  data: dataOverride,
  onNodeClick,
  depth = 2,
}: TaskDependencyGraphProps): JSX.Element {
  const dataQuery = useQuery({
    queryKey: ['tasks', taskId, 'graph', depth],
    queryFn: () => api.get<DependencyGraph>(`/tasks/${taskId}/graph?depth=${depth}`),
    // The graph only changes when links are added / removed, which doesn't
    // happen often. 30s staleTime is plenty + avoids hammering on every
    // drawer open.
    staleTime: 30_000,
    enabled: dataOverride === undefined,
  });
  const graph = dataOverride ?? dataQuery.data;

  // ---- Pan / zoom state ----
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );

  function onWheel(e: React.WheelEvent<SVGSVGElement>): void {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((s) => Math.max(0.5, Math.min(2, +(s + delta).toFixed(2))));
  }

  function onMouseDown(e: React.MouseEvent<SVGSVGElement>): void {
    // Only drag from the SVG background — clicks on individual nodes are
    // handled by their own onClick. We check the target tag against `<svg>`
    // to avoid swallowing node clicks behind a drag-start.
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.tagName !== 'svg' && !t.classList.contains('graph-bg')) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: translate.x,
      baseY: translate.y,
    };
  }

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>): void {
    if (!dragRef.current) return;
    setTranslate({
      x: dragRef.current.baseX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.baseY + (e.clientY - dragRef.current.startY),
    });
  }
  function onMouseUp(): void {
    dragRef.current = null;
  }

  const layout = useMemo<LaidOutGraph | null>(
    () => (graph ? layoutDependencyGraph(graph) : null),
    [graph],
  );

  if (dataQuery.isLoading && !dataOverride) {
    return (
      <div className="rounded-md border border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
        Loading graph…
      </div>
    );
  }
  if (!layout || layout.nodes.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
        No linked tasks yet — add a link from the section above to see the graph.
      </div>
    );
  }

  const viewBox = `${-translate.x / scale} ${-translate.y / scale} ${layout.width / scale} ${
    layout.height / scale
  }`;

  return (
    <div className="rounded-md border border-border bg-card/40 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/60 bg-muted/20">
        <span className="text-[11px] text-muted-foreground">
          {layout.nodes.length} task{layout.nodes.length === 1 ? '' : 's'}, {layout.edges.length}{' '}
          link{layout.edges.length === 1 ? '' : 's'} — drag to pan, scroll to zoom
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-background hover:bg-accent/60"
            onClick={() => setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)))}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-background hover:bg-accent/60"
            onClick={() => setScale((s) => Math.min(2, +(s + 0.1).toFixed(2)))}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-background hover:bg-accent/60"
            onClick={() => {
              setScale(1);
              setTranslate({ x: 0, y: 0 });
            }}
            aria-label="Reset view"
          >
            Reset
          </button>
        </div>
      </div>
      <svg
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{ width: '100%', height: 360, cursor: dragRef.current ? 'grabbing' : 'grab' }}
        role="img"
        aria-label="Task dependency graph"
      >
        {/* background rect — gives mouse-drag a target. The class lets us
            distinguish drag-on-background from drag-on-node in onMouseDown. */}
        <rect
          className="graph-bg"
          x={-10000}
          y={-10000}
          width={20000}
          height={20000}
          fill="transparent"
        />
        {/* arrowhead marker */}
        <defs>
          <marker
            id="dep-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(148 163 184)" />
          </marker>
        </defs>
        {/* edges */}
        {layout.edges.map((edge) => {
          const from = layout.nodes.find((n) => n.id === edge.from);
          const to = layout.nodes.find((n) => n.id === edge.to);
          if (!from || !to) return null;
          const startX = from.x + NODE_WIDTH;
          const startY = from.y + NODE_HEIGHT / 2;
          const endX = to.x;
          const endY = to.y + NODE_HEIGHT / 2;
          const ctrlOffset = Math.max(40, Math.abs(endX - startX) / 2);
          const path = `M ${startX} ${startY} C ${startX + ctrlOffset} ${startY}, ${
            endX - ctrlOffset
          } ${endY}, ${endX} ${endY}`;
          const isBlocks = edge.kind === 'blocks';
          return (
            <path
              key={`${edge.from}-${edge.to}-${edge.kind}`}
              d={path}
              fill="none"
              stroke={
                isBlocks ? 'rgb(239 68 68 / 0.6)' : 'rgb(148 163 184 / 0.5)'
              }
              strokeWidth={isBlocks ? 2 : 1.5}
              strokeDasharray={edge.kind === 'related' ? '4 3' : undefined}
              markerEnd="url(#dep-arrow)"
            />
          );
        })}
        {/* nodes */}
        {layout.nodes.map((node) => {
          const color = statusColor(node.status);
          const isFocal = node.id === layout.focalId;
          return (
            <g
              key={node.id}
              data-testid={`graph-node-${node.id}`}
              transform={`translate(${node.x} ${node.y})`}
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                onNodeClick?.(node.id);
              }}
            >
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={6}
                ry={6}
                fill={color.fill}
                stroke={isFocal ? 'rgb(59 130 246)' : color.stroke}
                strokeWidth={isFocal ? 2.5 : 1.25}
              />
              <text
                x={10}
                y={20}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
                fontSize={11}
                fill="rgb(148 163 184)"
              >
                {node.key}
              </text>
              <text
                x={10}
                y={40}
                fontFamily="system-ui, sans-serif"
                fontSize={12}
                fill="currentColor"
              >
                {node.title.length > 24 ? `${node.title.slice(0, 22)}…` : node.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
