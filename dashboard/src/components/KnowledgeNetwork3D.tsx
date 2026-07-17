/**
 * Spherical Knowledge Graph — Interactive 3D Knowledge Planet
 *
 * Dynamically loaded — Three.js WebGL may fail on headless/VM environments.
 * Falls back gracefully to a "3D not supported" message.
 */

import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Loader2 } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────
interface GraphNode {
  id: string;
  label?: string;
  name?: string;
  type?: string;
  file?: string;
  layer?: number; // 0=core, 1=middle, 2=outer
  children?: GraphNode[];
  _x?: number;
  _y?: number;
  _z?: number;
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

// ─── Fallback TextGraph when Three.js unavailable ──────────
function TextGraph({ data, height }: { data: GraphData; height: number }) {
  const connections = data.links?.length || 0;
  const nodes = data.nodes?.length || 0;
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.9rem', flexDirection: 'column', gap: '0.5rem' }}>
      <div>📊 {nodes} nodes · {connections} connections</div>
      <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>3D visualization requires WebGL (unavailable in this browser)</div>
    </div>
  );
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
}

export function SphericalKnowledgeGraph({
  analysis, concepts, dreams, searchQuery, activeFilters,
  onNodeHover, onNodeClick
}: SphericalKnowledgeGraphProps = {}) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [threeReady, setThreeReady] = useState(false);
  const [ForceGraph3DComponent, setForceGraph3DComponent] = useState<any>(null);

  // Load Three.js dynamically — may fail on headless/VM
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Try rendering a small canvas to check WebGL
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl') || testCanvas.getContext('webgl2');
        if (!gl) throw new Error('WebGL not available');
        (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();

        const mod = await import('3d-force-graph');
        if (!cancelled) {
          setForceGraph3DComponent(() => mod.default);
          setThreeReady(true);
        }
      } catch {
        if (!cancelled) setThreeReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Update graph data from analysis prop
  useEffect(() => {
    if (analysis?.graph) {
      setGraphData(analysis.graph);
    } else {
      setGraphData(null);
    }
  }, [analysis]);

  if (!graphData) {
    return (
      <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        No graph data available for this project.
      </div>
    );
  }

  if (!threeReady || !ForceGraph3DComponent) {
    return <TextGraph data={graphData} height={400} />;
  }

  return <ForceGraph3DCanvas ForceGraph3D={ForceGraph3DComponent} data={graphData} />;
}

// ─── Actual 3D renderer (lazy, only if WebGL available) ───
function ForceGraph3DCanvas({ ForceGraph3D, data }: { ForceGraph3D: any; data: GraphData }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = '';

    try {
      const graph = ForceGraph3D()(containerRef.current);

      graph
        .graphData(data)
        .width(container.clientWidth)
        .height(400)
        .nodeLabel((n: GraphNode) => n.label || n.name || n.id)
        .nodeColor(() => '#00F0FF')
        .linkColor(() => 'rgba(0, 240, 255, 0.2)')
        .backgroundColor('#0a0a0a');
      
      return () => {
        graph.destroy();
      };
    } catch (err) {
      console.warn('[3D] Render failed:', err);
      container.innerHTML = '<div style="height:400px;display:flex;align-items:center;justify-content:center;color:#666">3D render failed</div>';
    }
  }, [ForceGraph3D, data]);

  return <div ref={containerRef} style={{ width: '100%', height: '400px' }} />;
}
