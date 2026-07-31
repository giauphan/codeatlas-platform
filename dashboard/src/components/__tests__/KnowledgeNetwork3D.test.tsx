/**
 * SphericalKnowledgeGraph — click-to-show-label behavior tests.
 *
 * force-graph renders to canvas in real DOM; jsdom has no canvas.
 * We mock the library to capture the callbacks it registers and verify
 * the label-drawing logic directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { SphericalKnowledgeGraph } from '../KnowledgeNetwork3D';

// ─── Mock force-graph ─────────────────────────────────────────
type GraphCanvasCb = (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => void;
type GraphClickCb = (node: any) => void;

let mockOnClickCallback: GraphClickCb | null = null;
let mockCanvasCallback: GraphCanvasCb | null = null;

const mockGraphInstance: any = {
  graphData: vi.fn(() => mockGraphInstance),
  width: vi.fn(() => mockGraphInstance),
  height: vi.fn(() => mockGraphInstance),
  nodeVal: vi.fn(() => mockGraphInstance),
  nodeLabel: vi.fn(() => mockGraphInstance),
  nodeRelSize: vi.fn(() => mockGraphInstance),
  nodeColor: vi.fn(() => mockGraphInstance),
  linkColor: vi.fn(() => mockGraphInstance),
  linkWidth: vi.fn(() => mockGraphInstance),
  backgroundColor: vi.fn(() => mockGraphInstance),
  zoom: vi.fn(() => mockGraphInstance),
  onNodeHover: vi.fn(() => mockGraphInstance),
  onNodeClick: vi.fn((cb: GraphClickCb) => {
    mockOnClickCallback = cb;
    return mockGraphInstance;
  }),
  nodeCanvasObject: vi.fn((cb: GraphCanvasCb) => {
    mockCanvasCallback = cb;
    return mockGraphInstance;
  }),
  centerAt: vi.fn(),
  d3ReheatSimulation: vi.fn(),
  autoPauseRedraw: vi.fn(() => mockGraphInstance),
  _destructor: vi.fn(),
};

vi.mock('force-graph', () => ({
  default: vi.fn(() => (_container: HTMLElement) => mockGraphInstance),
}));

// ─── Stub context ─────────────────────────────────────────────
const fillTextMock = vi.fn();
const measureTextMock = vi.fn(() => ({ width: 50 }));

const minimalCtx = {
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  quadraticCurveTo: vi.fn(),
  set fillStyle(v: string) { /* noop */ },
  set font(v: string) { /* noop */ },
  set textAlign(v: CanvasTextAlign) { /* noop */ },
  set textBaseline(v: CanvasTextBaseline) { /* noop */ },
  fillText: fillTextMock,
  measureText: measureTextMock,
} as unknown as CanvasRenderingContext2D;

// ─── Sample graph data ─────────────────────────────────────────
const sampleAnalysis = {
  entityCounts: {},
  graph: {
    nodes: [
      { id: 'node-fun', label: 'myFunction', name: 'myFunction', type: 'function', x: 100, y: 200 },
      { id: 'node-bar', label: 'barModule',  name: 'barModule',  type: 'module',   x: 300, y: 400 },
    ],
    links: [
      { source: 'node-fun', target: 'node-bar' },
    ],
  },
};

// ─── Helpers ──────────────────────────────────────────────────
function renderGraph() {
  return render(
    <SphericalKnowledgeGraph
      analysis={sampleAnalysis}
      searchQuery=""
      activeFilters={['module', 'function', 'class', 'variable']}
      typeColors={{ module: '#00F0FF', function: '#FF00A8', class: '#FFB400', variable: '#00FF94' }}
      onNodeClick={vi.fn()}
    />
  );
}

function findLabelCall(label: string): any[] | undefined {
  return fillTextMock.mock.calls.find((args: any[]) => args[0] === label);
}

beforeEach(() => {
  mockOnClickCallback = null;
  mockCanvasCallback = null;
  // Clear calls but keep implementation (measureText returns {width:50})
  fillTextMock.mockClear();
  measureTextMock.mockClear();
});

// ─── Tests ─────────────────────────────────────────────────────
describe('click node → show label', () => {
  it('draws no label before any click', () => {
    renderGraph();
    expect(mockCanvasCallback).toBeTruthy();
    expect(mockGraphInstance.autoPauseRedraw).toHaveBeenCalledWith(false);

    mockCanvasCallback!(sampleAnalysis.graph.nodes[0], minimalCtx, 1);

    expect(findLabelCall('myFunction')).toBeUndefined();
  });

  it('draws label text for clicked node', () => {
    renderGraph();
    expect(mockOnClickCallback).toBeTruthy();

    mockOnClickCallback!(sampleAnalysis.graph.nodes[0]);
    mockCanvasCallback!(sampleAnalysis.graph.nodes[0], minimalCtx, 1);

    expect(minimalCtx.arc).toHaveBeenCalledWith(100, 200, 4, 0, 2 * Math.PI, false);
    expect(measureTextMock).toHaveBeenCalled();
    expect(findLabelCall('myFunction')).toBeTruthy();
  });

  it('clears label when clicking the same node again (toggle)', () => {
    renderGraph();

    // Click → show label
    mockOnClickCallback!(sampleAnalysis.graph.nodes[0]);
    mockCanvasCallback!(sampleAnalysis.graph.nodes[0], minimalCtx, 1);
    const afterFirst = fillTextMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Click again → hide label
    mockOnClickCallback!(sampleAnalysis.graph.nodes[0]);
    mockCanvasCallback!(sampleAnalysis.graph.nodes[0], minimalCtx, 1);
    const newCalls = fillTextMock.mock.calls.slice(afterFirst);
    const hasLabel = newCalls.some((args: any[]) => args[0] === 'myFunction');
    expect(hasLabel).toBe(false);
  });

  it('switches label when clicking a different node', () => {
    renderGraph();

    // Click node-fun → label shows "myFunction"
    mockOnClickCallback!(sampleAnalysis.graph.nodes[0]);
    mockCanvasCallback!(sampleAnalysis.graph.nodes[0], minimalCtx, 1);
    const afterFirst = fillTextMock.mock.calls.length;
    expect(findLabelCall('myFunction')).toBeTruthy();

    // Click node-bar → label switches to "barModule" (no "myFunction" after this point)
    mockOnClickCallback!(sampleAnalysis.graph.nodes[1]);
    mockCanvasCallback!(sampleAnalysis.graph.nodes[0], minimalCtx, 1);
    mockCanvasCallback!(sampleAnalysis.graph.nodes[1], minimalCtx, 1);

    const newCalls = fillTextMock.mock.calls.slice(afterFirst);
    expect(newCalls.some((args: any[]) => args[0] === 'myFunction')).toBe(false);
    expect(newCalls.some((args: any[]) => args[0] === 'barModule')).toBe(true);
  });

  it('calls onNodeClick prop when node is clicked', () => {
    const onNodeClick = vi.fn();
    render(
      <SphericalKnowledgeGraph
        analysis={sampleAnalysis}
        activeFilters={['function']}
        typeColors={{ function: '#FF00A8' }}
        onNodeClick={onNodeClick}
      />
    );

    mockOnClickCallback!(sampleAnalysis.graph.nodes[0]);
    expect(onNodeClick).toHaveBeenCalledWith(sampleAnalysis.graph.nodes[0]);
  });
});
