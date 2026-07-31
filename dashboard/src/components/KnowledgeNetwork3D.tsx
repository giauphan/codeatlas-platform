/**
 * Spherical Knowledge Graph — Interactive 2D Knowledge Planet
 *
 * Falls back gracefully to a text-based summary.
 */

import React, { useRef, useEffect, useState } from 'react';
import ForceGraph2D from 'force-graph';

// ─── Types ──────────────────────────────────────────────────
interface GraphNode {
  id: string;
  label?: string;
  name?: string;
  type?: string;
  file?: string;
  filePath?: string;
  line?: number;
  layer?: number; // 0=core, 1=middle, 2=outer
  children?: GraphNode[];
}

interface GraphLink {
  source: string;
  target: string;
  type?: string;
  strength?: number;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// ─── Main Export ───────────────────────────────────────────
interface SphericalKnowledgeGraphProps {
  analysis?: any;
  concepts?: any[];
  dreams?: any[];
  searchQuery?: string;
  activeFilters?: string[];
  typeColors?: Record<string, string>;
  onNodeHover?: (node: GraphNode | null) => void;
  onNodeClick?: (node: GraphNode) => void;
  isFullscreen?: boolean;
}

export function SphericalKnowledgeGraph({
  analysis, concepts, dreams, searchQuery, activeFilters,
  onNodeHover, onNodeClick, isFullscreen, typeColors
}: SphericalKnowledgeGraphProps = {}) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [totalNodes, setTotalNodes] = useState(0);
  const [totalLinks, setTotalLinks] = useState(0);

  const MAX_INITIAL_NODES = 200;

  // Update graph data from analysis prop, filter invalid links and limit initial render
  useEffect(() => {
    if (analysis?.graph) {
      const allNodes: GraphNode[] = analysis.graph.nodes;
      const allLinks: GraphLink[] = analysis.graph.links;

      // Apply filter based on activeFilters
      const filteredNodesByType = allNodes.filter(node => 
        activeFilters?.includes(node.type || '')
      );

      const nodeIds = new Set(filteredNodesByType.map((n: GraphNode) => n.id));
      const clonedLinks = allLinks.map((l: GraphLink) => ({ ...l }));
      const filteredLinks = clonedLinks.filter(
        (l: GraphLink) => nodeIds.has(l.source) && nodeIds.has(l.target)
      );
      
      setTotalNodes(filteredNodesByType.length);
      setTotalLinks(filteredLinks.length);

      if (!showAll && filteredNodesByType.length > MAX_INITIAL_NODES) {
        const limitedNodes = filteredNodesByType.slice(0, MAX_INITIAL_NODES);
        const limitedNodeIds = new Set(limitedNodes.map((n: GraphNode) => n.id));
        const limitedLinks = filteredLinks.filter(
          (l: GraphLink) => limitedNodeIds.has(l.source) && limitedNodeIds.has(l.target)
        );
        setGraphData({ nodes: limitedNodes, links: limitedLinks });
      } else {
        setGraphData({ nodes: filteredNodesByType, links: filteredLinks });
      }
    } else {
      setGraphData(null);
    }
  }, [analysis, showAll, activeFilters]); // Add activeFilters to dependencies

  if (!graphData) {
    return (
      <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        No graph data available for this project.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      {!showAll && totalNodes > MAX_INITIAL_NODES && (
        <div style={{
          position: 'absolute', bottom: '4.5rem', left: '50%', transform: 'translateX(-50%)',
          zIndex: 10,
        }}>
          <button
            onClick={() => setShowAll(true)}
            style={{
              padding: '0.6rem 1.5rem', borderRadius: '20px', border: 'none',
              background: 'linear-gradient(45deg, #00BFFF, #00FFFF)',
              color: '#000', fontWeight: 700, cursor: 'pointer',
              fontSize: '0.85rem', boxShadow: '0 0 20px rgba(0, 240, 255, 0.4)',
            }}
          >
            Load All ({totalNodes} nodes, {totalLinks} links)
          </button>
        </div>
      )}
      <ForceGraph2DCanvas data={graphData} isFullscreen={isFullscreen} searchQuery={searchQuery} typeColors={typeColors} onNodeHover={onNodeHover} onNodeClick={onNodeClick} />
    </div>
  );
}

// ─── Actual 2D renderer ───
function ForceGraph2DCanvas({ data, isFullscreen, searchQuery, typeColors, onNodeHover, onNodeClick }: {
  data: GraphData; isFullscreen?: boolean; searchQuery?: string; typeColors?: Record<string, string>;
  onNodeHover?: (n: GraphNode | null) => void; onNodeClick?: (n: GraphNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  // Use refs for callbacks so effect doesn't depend on inline fn refs from parent
  const onNodeHoverRef = useRef(onNodeHover);
  const onNodeClickRef = useRef(onNodeClick);
  onNodeHoverRef.current = onNodeHover;
  onNodeClickRef.current = onNodeClick;

  const clickedNodeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    container.innerHTML = '';

    const colors = typeColors || {
      module: '#00F0FF',
      function: '#FF00A8',
      class: '#FFB400',
      variable: '#00FF94',
    };

    // Node color: type-based, search dims non-matches
    const getNodeColor = (n: GraphNode): string => {
      const typeColor = colors[n.type || ''];
      const baseColor = typeColor || 'rgba(255,255,255,0.4)';

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const label = (n.label || n.name || n.id).toLowerCase();
        return label.includes(q) ? baseColor : 'rgba(255,255,255,0.08)';
      }
      return baseColor;
    };

    const getLinkColor = (l: any): string => {
      return searchQuery ? 'rgba(255,255,255,0.05)' : 'rgba(0, 240, 255, 0.15)';
    };

    const getLinkWidth = (): number => 0.5;

    const graph = ForceGraph2D()(container)
      .graphData(data)
      .width(isFullscreen ? window.innerWidth : container.clientWidth)
      .height(isFullscreen ? window.innerHeight : 400)
      .autoPauseRedraw(false)
      .nodeVal(2)
      .nodeLabel((n: GraphNode) => {
        const name = n.label || n.name || n.id;
        return n.filePath ? `${name}  ·  ${n.filePath}` : name;
      })
      .nodeRelSize(4)
      .nodeColor(getNodeColor)
      .linkColor(getLinkColor)
      .linkWidth(getLinkWidth)
      .backgroundColor('#0a0a0a')
      .zoom(1.5)
      .onNodeHover((node: any) => {
        container.style.cursor = node ? 'pointer' : 'default';
        if (onNodeHoverRef.current) onNodeHoverRef.current(node);
      })
      .onNodeClick((node: any) => {
        if (!node) return;
        clickedNodeIdRef.current = clickedNodeIdRef.current === node.id ? null : node.id;
        graph.centerAt(node.x || 0, node.y || 0, 600);
        graph.zoom(2, 600);
        if (onNodeClickRef.current) onNodeClickRef.current(node);
        // Reheat simulation so nodeCanvasObject repaints with label
        graph.d3ReheatSimulation();
      })
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        // Draw node circle
        const color = getNodeColor(node);
        ctx.beginPath();
        ctx.arc(node.x, node.y, 4, 0, 2 * Math.PI, false);
        ctx.fillStyle = color;
        ctx.fill();

        // Draw label for clicked node
        if (clickedNodeIdRef.current === node.id) {
          const label = node.label || node.name || node.id;
          const fontSize = Math.max(12 / globalScale, 6);
          ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
          const textWidth = ctx.measureText(label).width;
          const pad = 4;
          const bx = node.x + 6 - pad;
          const by = node.y - fontSize / 2 - pad;
          const bw = textWidth + pad * 2;
          const bh = fontSize + pad * 2;
          const r = 4;
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.beginPath();
          ctx.moveTo(bx + r, by);
          ctx.lineTo(bx + bw - r, by);
          ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
          ctx.lineTo(bx + bw, by + bh - r);
          ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
          ctx.lineTo(bx + r, by + bh);
          ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
          ctx.lineTo(bx, by + r);
          ctx.quadraticCurveTo(bx, by, bx + r, by);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#00F0FF';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, node.x + 6, node.y);
        }
      });

    graphRef.current = graph;

    return () => {
      graph._destructor();
      graphRef.current = null;
    };
  }, [data, isFullscreen, searchQuery]); // Stable deps — no callback fns

  return (
    <>
      <style>{`
        .float-tooltip-kap {
          background: rgba(0,0,0,0.88) !important;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          padding: 6px 12px;
          backdrop-filter: blur(8px);
          font: 13px system-ui, sans-serif;
          color: #eee;
          max-width: 360px;
          white-space: pre-line;
          word-break: break-word;
          line-height: 1.5;
          z-index: 1000;
          pointer-events: none;
        }
      `}</style>
      <div ref={containerRef} style={{ width: '100%', height: isFullscreen ? '100vh' : '400px' }} />
    </>
  );
}

