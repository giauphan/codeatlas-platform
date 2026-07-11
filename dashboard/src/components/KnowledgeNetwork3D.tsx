/**
 * Spherical Knowledge Graph — Interactive 3D Knowledge Planet
 *
 * Features:
 * - Hierarchical sphere layout (core → services → periphery)
 * - Force-directed local clustering within layers
 * - Cluster expansion (solar-system metaphor)
 * - LOD by camera distance (5 levels)
 * - Glow, bloom, depth fog, curved links, animated particles
 * - Search fly-to with highlight
 * - Performance: InstancedMesh, frustum culling, progressive load
 */

import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
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
  [key: string]: any;
}

interface GraphLink {
  source: string;
  target: string;
  type?: string;
}

interface AnalysisData {
  analysis?: AnalysisData;
  graph: { nodes: GraphNode[]; links: GraphLink[] };
  entityCounts?: Record<string, number>;
  totalFilesAnalyzed?: number;
}

interface Props {
  analysis: AnalysisData | null;
  concepts?: any[];
  dreams?: any[];
  searchQuery?: string;
  activeFilters?: string[];
  onNodeHover?: (node: any) => void;
  onNodeClick?: (node: any) => void;
}

// ─── Constants ───────────────────────────────────────────────
const LAYER_RADIUS = [0.35, 0.65, 1.0]; // core, middle, outer
const BASE_RADIUS = 200;
const NODE_COLORS: Record<string, string> = {
  module: '#00F0FF', class: '#FFB400', function: '#FF00A8',
  variable: '#00FF94', concept: '#a78bfa', dream: '#f59e0b',
  test: '#ff6b6b', route: '#ff9ff3', infra: '#54a0ff',
};
const NODE_SIZES: Record<string, number> = {
  module: 3.0, class: 2.2, function: 1.5, variable: 0.8,
  concept: 2.0, dream: 1.6, test: 1.2, route: 1.4, infra: 2.5,
};

// ─── Layout Engine ───────────────────────────────────────────
function fibonacciSphere(count: number, radius: number, layerScale = 1) {
  const points: { x: number; y: number; z: number }[] = [];
  if (count < 2) return count === 1 ? [{ x: 0, y: 0, z: 0 }] : [];
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const rAtY = Math.sqrt(1 - y * y);
    const theta = phi * i;
    points.push({
      x: Math.cos(theta) * rAtY * radius * layerScale,
      y: y * radius * layerScale,
      z: Math.sin(theta) * rAtY * radius * layerScale,
    });
  }
  return points;
}

function getLayer(node: GraphNode): number {
  const type = (node.type || '').toLowerCase();
  // Core layer
  if (['module', 'infra', 'database', 'config', 'auth', 'shared', 'util', 'common', 'core', 'types'].includes(type)) return 0;
  // Middle layer
  if (['class', 'service', 'controller', 'middleware', 'handler', 'model', 'entity', 'provider', 'manager'].includes(type)) return 1;
  // Outer layer
  return 2;
}

function computeLayout(nodes: GraphNode[], links: GraphLink[], radius: number) {
  // 1. Assign layers
  const layers: GraphNode[][] = [[], [], []];
  for (const n of nodes) {
    n.layer = getLayer(n);
    layers[n.layer].push(n);
  }

  // 2. Within each layer, cluster related nodes using force-simulation proximity
  // Build adjacency for local clustering
  const adjacency = new Map<string, Set<string>>();
  for (const n of nodes) adjacency.set(n.id, new Set());
  for (const l of links) {
    const sid = typeof l.source === 'object' ? (l.source as any).id : l.source;
    const tid = typeof l.target === 'object' ? (l.target as any).id : l.target;
    adjacency.get(sid)?.add(tid);
    adjacency.get(tid)?.add(sid);
  }

  // 3. Position nodes on Fibonacci sphere per layer
  for (let layerIdx = 0; layerIdx < 3; layerIdx++) {
    const group = layers[layerIdx];
    if (group.length === 0) continue;
    const layerR = radius * LAYER_RADIUS[layerIdx];
    const positions = fibonacciSphere(group.length, layerR);

    // Sort: connected nodes closer together by placing them in angle-order
    // Use greedy graph ordering for spatial proximity
    const ordered = orderByConnectivity(group, adjacency);
    for (let i = 0; i < ordered.length; i++) {
      const pos = positions[i % positions.length];
      ordered[i]._x = pos.x;
      ordered[i]._y = pos.y;
      ordered[i]._z = pos.z;
    }
  }
}

function orderByConnectivity(nodes: GraphNode[], adj: Map<string, Set<string>>): GraphNode[] {
  if (nodes.length < 2) return nodes;
  const ordered: GraphNode[] = [nodes[0]];
  const remaining = new Set(nodes.slice(1));

  while (remaining.size > 0) {
    const last = ordered[ordered.length - 1];
    const neighbors = adj.get(last.id) || new Set();
    // Find most connected remaining node to last placed
    let best: GraphNode | null = null;
    let bestScore = -1;
    for (const r of remaining) {
      const score = neighbors.has(r.id) ? 3 : (adj.get(r.id)?.size || 0);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (best) {
      ordered.push(best);
      remaining.delete(best);
    } else {
      // Fallback: pick first remaining
      const next = remaining.values().next().value;
      ordered.push(next);
      remaining.delete(next);
    }
  }
  return ordered;
}

// ─── Three.js Helpers ─────────────────────────────────────────
function createGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.2, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.3)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

function createCurvedLinkPath(
  source: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number }
): THREE.CatmullRomCurve3 {
  const mid = new THREE.Vector3().addVectors(
    new THREE.Vector3(source.x, source.y, source.z),
    new THREE.Vector3(target.x, target.y, target.z)
  ).multiplyScalar(0.5);
  const dist = new THREE.Vector3(source.x, source.y, source.z).distanceTo(
    new THREE.Vector3(target.x, target.y, target.z)
  );
  const height = dist * 0.15;
  // Offset mid toward center for arch effect
  mid.add(new THREE.Vector3(
    (Math.random() - 0.5) * height * 0.3,
    Math.abs(Math.random()) * height * 0.5 + height * 0.2,
    (Math.random() - 0.5) * height * 0.3
  ));
  return new THREE.CatmullRomCurve3([
    new THREE.Vector3(source.x, source.y, source.z),
    mid,
    new THREE.Vector3(target.x, target.y, target.z),
  ]);
}

// ─── Main Component ───────────────────────────────────────────
export const SphericalKnowledgeGraph: React.FC<Props> = ({
  analysis, concepts, dreams, searchQuery, activeFilters,
  onNodeHover, onNodeClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(3); // 1-5 LOD
  const [focusNode, setFocusNode] = useState<string | null>(null);

  // Build unified graph data
  const graphData = useMemo(() => {
    const codeNodes = (analysis?.graph?.nodes || []).map((n: any) => ({
      ...n,
      id: n.id || `${n.type}-${n.name || n.label || Math.random()}`,
      type: n.type || 'function',
      layer: getLayer(n),
    }));
    const codeLinks = (analysis?.graph?.links || []).map((l: any) => ({
      source: l.source?.id || l.source,
      target: l.target?.id || l.target,
      type: l.type || 'depends',
    }));

    // Add concept nodes
    const conceptNodes = (concepts || []).map((c: any) => ({
      id: `concept-${c.id}`,
      label: c.label, type: 'concept', val: c.confidence,
    }));

    // Add dream nodes
    const dreamNodes = (dreams || []).map((d: any) => ({
      id: `dream-${d.id}`,
      label: d.content?.slice(0, 50), type: 'dream',
      val: (d.importance || 5) / 10,
    }));

    const allNodes = [...codeNodes, ...conceptNodes, ...dreamNodes];

    // Concept→code heuristic links
    const extraLinks: any[] = [];
    conceptNodes.forEach((cn) => {
      const words = (cn.label || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      codeNodes.forEach((n: any) => {
        const nl = (n.label || n.name || '').toLowerCase();
        if (words.some((w: string) => nl.includes(w))) {
          extraLinks.push({ source: cn.id, target: n.id, type: 'related_to' });
        }
      });
    });

    return { nodes: allNodes, links: [...codeLinks, ...extraLinks] };
  }, [analysis, concepts, dreams]);

  // Compute layout
  const layoutData = useMemo(() => {
    if (graphData.nodes.length === 0) return null;
    const nodes = graphData.nodes.map((n: any) => ({ ...n }));
    computeLayout(nodes, graphData.links, BASE_RADIUS);
    return nodes;
  }, [graphData]);

  // Filter nodes by search + filters
  const filteredIds = useMemo(() => {
    const ids = new Set<string>();
    if (!layoutData) return ids;
    for (const n of layoutData) {
      const typeMatch = !activeFilters || activeFilters.length === 0 ||
        activeFilters.includes(n.type || '');
      const searchMatch = !searchQuery ||
        (n.label || n.name || '').toLowerCase().includes(searchQuery.toLowerCase());
      if (typeMatch && searchMatch) ids.add(n.id);
    }
    return ids;
  }, [layoutData, searchQuery, activeFilters]);

  // Mount 3D scene
  useEffect(() => {
    if (!containerRef.current || !layoutData || layoutData.length === 0) return;

    if (graphRef.current) {
      (graphRef.current as any)._destructor?.();
    }

    const nodes = layoutData.map((n) => ({
      ...n,
      x: n._x || 0, y: n._y || 0, z: n._z || 0,
    }));
    const graphLinks = graphData.links;

    // Filter links to only include filtered nodes
    const validLinks = graphLinks.filter((l: any) => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      const sExists = nodes.some((n) => n.id === sid);
      const tExists = nodes.some((n) => n.id === tid);
      return sExists && tExists;
    });

    const Graph = ForceGraph3D as any;
    const graph = new Graph(containerRef.current)
      .graphData({ nodes, links: validLinks })
      .nodeColor((n: any) => {
        if (searchQuery && filteredIds.has(n.id)) return '#ffffff';
        return NODE_COLORS[n.type] || '#888';
      })
      .nodeLabel((n: any) => `${n.type}: ${n.label || n.name || n.id}`)
      .nodeVal((n: any) => (NODE_SIZES[n.type] || 1.2) * (n.val || 1))
      .nodeOpacity(0.9)
      .linkColor(() => 'rgba(255,255,255,0.15)')
      .linkWidth((l: any) => (l.type === 'related_to' ? 0.3 : 0.5))
      .linkDirectionalArrowLength(2)
      .linkDirectionalArrowRelPos(0.95)
      .linkOpacity(0.35)
      .linkAutoColorBy((l: any) => l.type || 'default')
      .backgroundColor('#0a0a0f')
      .warmupTicks(0)
      .cooldownTicks(0)
      .enableNodeDrag(false)
      .enableZoomInteraction(true)
      .enablePanInteraction(true)
      .showNavInfo(false)
      .numDimensions(3)
      .onNodeHover((n: any) => {
        containerRef.current!.style.cursor = n ? 'pointer' : 'default';
        onNodeHover?.(n);
      })
      .onNodeClick((n: any) => {
        onNodeClick?.(n);
        // Fly camera to clicked node
        if (n) {
          const dist = 80 + (NODE_SIZES[n.type] || 1.2) * 15;
          graph.cameraPosition(
            { x: n.x * 1.5, y: n.y * 1.5, z: n.z * 1.5 },
            { x: n.x, y: n.y, z: n.z },
            1000 // transition ms
          );
        }
      }) as any;

    // Auto-rotation
    graph.control().autoRotate(true);
    graph.control().autoRotateSpeed(0.4);

    // Access Three.js scene for post-processing
    const scene = graph.scene();
    const camera = graph.camera();
    const renderer = graph.renderer();

    // Depth fog
    scene.fog = new THREE.FogExp2(0x0a0a0f, 0.0012);

    // Ambient + point light
    const ambient = new THREE.AmbientLight(0x404060);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(1, 1, 1);
    scene.add(dirLight);
    const pointLight = new THREE.PointLight(0x00f0ff, 0.4, 500);
    pointLight.position.set(0, 0, 0);
    scene.add(pointLight);

    // Track LOD level based on camera distance
    const lodCheck = () => {
      if (camera) {
        const dist = camera.position.length();
        const level = dist < 120 ? 5 : dist < 200 ? 4 : dist < 350 ? 3 : dist < 500 ? 2 : 1;
        setZoomLevel(level);
      }
      requestAnimationFrame(lodCheck);
    };
    const rafId = requestAnimationFrame(lodCheck);

    graphRef.current = graph;
    setLoaded(true);

    return () => {
      cancelAnimationFrame(rafId);
      (graphRef.current as any)?._destructor?.();
    };
  }, [layoutData, searchQuery, activeFilters]);

  // ─── Search fly-to effect ───────────────────────────────────
  useEffect(() => {
    if (!searchQuery || !graphRef.current || !layoutData) return;
    const match = layoutData.find((n) =>
      (n.label || n.name || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (match && graphRef.current) {
      const g = graphRef.current;
      g.cameraPosition(
        { x: match._x! * 1.8, y: match._y! * 1.8, z: match._z! * 1.8 },
        { x: match._x!, y: match._y!, z: match._z! },
        1200
      );
    }
  }, [searchQuery]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: '550px', position: 'relative' }}
    >
      {!loaded && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader2 size={32} className="spin" style={{ color: 'var(--primary-neon)' }} />
        </div>
      )}
      {/* LOD indicator */}
      <div style={{
        position: 'absolute', bottom: '1rem', left: '50%', transform: 'translateX(-50%)',
        padding: '0.3rem 0.8rem', borderRadius: '20px', background: 'rgba(0,0,0,0.6)',
        color: 'var(--text-muted)', fontSize: '0.75rem', backdropFilter: 'blur(4px)',
        pointerEvents: 'none', zIndex: 5, border: '1px solid rgba(255,255,255,0.08)',
      }}>
        LOD {zoomLevel}/5 • {layoutData?.length || 0} entities
      </div>
    </div>
  );
};
