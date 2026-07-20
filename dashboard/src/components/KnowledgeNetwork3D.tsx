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
  onNodeHover?: (node: GraphNode | null) => void;
  onNodeClick?: (node: GraphNode) => void;
  isFullscreen?: boolean;
}

export function SphericalKnowledgeGraph({
  analysis, concepts, dreams, searchQuery, activeFilters,
  onNodeHover, onNodeClick, isFullscreen
}: SphericalKnowledgeGraphProps = {}) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [totalNodes, setTotalNodes] = useState(0);
  const [totalLinks, setTotalLinks] = useState(0);

  const MAX_INITIAL_NODES = 200;

  // Update graph data from analysis prop, filter invalid links and limit initial render
  useEffect(() => {
    if (analysis?.graph) {
      const nodeIds = new Set(analysis.graph.nodes.map((n: GraphNode) => n.id));
      const clonedLinks = analysis.graph.links.map((l: GraphLink) => ({ ...l }));
      const filteredLinks = clonedLinks.filter(
        (l: GraphLink) => nodeIds.has(l.source) && nodeIds.has(l.target)
      );
      setTotalNodes(analysis.graph.nodes.length);
      setTotalLinks(filteredLinks.length);

      if (!showAll && analysis.graph.nodes.length > MAX_INITIAL_NODES) {
        const limitedNodes = analysis.graph.nodes.slice(0, MAX_INITIAL_NODES);
        const limitedNodeIds = new Set(limitedNodes.map((n: GraphNode) => n.id));
        const limitedLinks = filteredLinks.filter(
          (l: GraphLink) => limitedNodeIds.has(l.source) && limitedNodeIds.has(l.target)
        );
        setGraphData({ nodes: limitedNodes, links: limitedLinks });
      } else {
        setGraphData({ nodes: analysis.graph.nodes, links: filteredLinks });
      }
    } else {
      setGraphData(null);
    }
  }, [analysis, showAll]);

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
      <ForceGraph2DCanvas data={graphData} isFullscreen={isFullscreen} />
    </div>
  );
}

// ─── Actual 2D renderer ───
function ForceGraph2DCanvas({ data, isFullscreen }: { data: GraphData; isFullscreen?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    
    // Clear container before re-creating graph
    container.innerHTML = '';
    
    const graph = ForceGraph2D()(container)
      .graphData(data)
      .width(isFullscreen ? window.innerWidth : container.clientWidth)
      .height(isFullscreen ? window.innerHeight : 400)
      .nodeLabel((n: GraphNode) => n.label || n.name || n.id)
      .nodeAutoColorBy('type')
      .linkColor(() => 'rgba(0, 240, 255, 0.2)')
      .backgroundColor('#0a0a0a');

    return () => {
      graph._destructor();
    };
  }, [data]);

  return <div ref={containerRef} style={{ width: '100%', height: isFullscreen ? '100vh' : '400px' }} />;
}

