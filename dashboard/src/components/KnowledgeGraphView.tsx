import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { 
  Box, 
  Code2, 
  Layers, 
  Activity, 
  Search 
} from 'lucide-react';

interface AnalysisData {
  stats?: {
    totalFiles?: number;
    totalModules?: number;
    totalClasses?: number;
    totalFunctions?: number;
    totalVariables?: number;
    loc?: number;
  };
  entityCounts?: {
    modules?: number;
    functions?: number;
    classes?: number;
    variables?: number;
    dependencies?: number;
    circularDeps?: number;
    deadCode?: number;
  };
  totalFilesAnalyzed?: number;
  graph: {
    nodes: any[];
    links: any[];
  };
}

interface KnowledgeGraphViewProps {
  analysis: AnalysisData | null;
}

export const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({ analysis }) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState(['module', 'function', 'class', 'variable']);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  
  // Interactive Viewport Pan & Zoom States
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const svgRef = React.useRef<SVGSVGElement>(null);
  const [mousePos, setMousePos] = useState({ x: 550, y: 350 });

  const filteredNodes = useMemo(() => {
    if (!analysis || !analysis.graph || !analysis.graph.nodes) return [];
    return analysis.graph.nodes.filter((n: any) => {
      const typeMatch = activeFilters.includes(n.type || 'function');
      const searchMatch = n.label.toLowerCase().includes(searchQuery.toLowerCase());
      return typeMatch && searchMatch;
    });
  }, [analysis, searchQuery, activeFilters]);

  // Keep physics simulation state in a local state updated on tick
  const [simNodes, setSimNodes] = useState<any[]>([]);

  // Initialize nodes with positions
  useEffect(() => {
    const centerX = 550;
    const centerY = 350;
    const initialNodes = filteredNodes.slice(0, 120).map((n, i) => {
      const isModule = n.type === 'module';
      const angle = (i * 2 * Math.PI) / (isModule ? 6 : 24);
      const radius = isModule ? 70 : 160 + (Math.floor(i / 20) * 55);
      return {
        ...n,
        x: centerX + Math.cos(angle) * radius + (Math.random() - 0.5) * 50,
        y: centerY + Math.sin(angle) * radius + (Math.random() - 0.5) * 50,
        vx: 0,
        vy: 0
      };
    });
    setSimNodes(initialNodes);
  }, [filteredNodes]);

  // Run Physics Loop (Force-Directed Simulation at 60fps)
  useEffect(() => {
    let animationId: number;
    
    const updatePhysics = () => {
      setSimNodes(prevNodes => {
        if (prevNodes.length === 0) return prevNodes;

        // Clone nodes to update positions/velocities
        const nodes = prevNodes.map(n => ({ ...n }));
        const nodeMap = new Map(nodes.map(n => [n.id, n]));

        const centerX = 550;
        const centerY = 350;

        // 1. Repulsion force between ALL nodes (Charge)
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const n1 = nodes[i];
            const n2 = nodes[j];
            const dx = n1.x - n2.x;
            const dy = n1.y - n2.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            // Repel if closer than thresholds
            const minDist = n1.type === 'module' || n2.type === 'module' ? 120 : 75;
            if (dist < minDist) {
              const force = (minDist - dist) * 0.08;
              const pushX = (dx / dist) * force;
              const pushY = (dy / dist) * force;
              
              n1.vx += pushX;
              n1.vy += pushY;
              n2.vx -= pushX;
              n2.vy -= pushY;
            }
          }
        }

        // 2. Link attraction force (Springs)
        if (analysis && analysis.graph && analysis.graph.links) {
          analysis.graph.links.forEach((l: any) => {
            const sourceNode = nodeMap.get(l.source);
            const targetNode = nodeMap.get(l.target);
            if (sourceNode && targetNode) {
              const dx = targetNode.x - sourceNode.x;
              const dy = targetNode.y - sourceNode.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const desiredDist = sourceNode.type === 'module' || targetNode.type === 'module' ? 95 : 65;
              
              // Pull connected nodes together
              const force = (dist - desiredDist) * 0.035;
              const pullX = (dx / dist) * force;
              const pullY = (dy / dist) * force;
              
              sourceNode.vx += pullX;
              sourceNode.vy += pullY;
              targetNode.vx -= pullX;
              targetNode.vy -= pullY;
            }
          });
        }

        // 3. Center Gravity & Boundary Limits
        nodes.forEach(n => {
          // Attract towards center
          const dx = centerX - n.x;
          const dy = centerY - n.y;
          const distToCenter = Math.sqrt(dx * dx + dy * dy) || 1;
          n.vx += (dx / distToCenter) * 0.08;
          n.vy += (dy / distToCenter) * 0.08;

          // Drag lock in transformed space
          if (n.id === draggedNodeId) {
            n.x = mousePos.x;
            n.y = mousePos.y;
            n.vx = 0;
            n.vy = 0;
          } else {
            // Apply velocities & damping
            n.x += n.vx;
            n.y += n.vy;
            n.vx *= 0.82;
            n.vy *= 0.82;
          }

          // Keep nodes inside reasonable viewport boundaries
          n.x = Math.max(50, Math.min(1050, n.x));
          n.y = Math.max(50, Math.min(650, n.y));
        });

        return nodes;
      });

      animationId = requestAnimationFrame(updatePhysics);
    };

    animationId = requestAnimationFrame(updatePhysics);
    return () => cancelAnimationFrame(animationId);
  }, [analysis, draggedNodeId, mousePos]);

  // Construct links array from simulation node coordinates
  const simulatedLinks = useMemo(() => {
    if (!analysis || !analysis.graph || !analysis.graph.links || simNodes.length === 0) return [];
    const nodeMap = new Map(simNodes.map(n => [n.id, n]));
    return analysis.graph.links
      .filter((l: any) => nodeMap.has(l.source) && nodeMap.has(l.target))
      .map(l => ({
        source: nodeMap.get(l.source),
        target: nodeMap.get(l.target)
      }));
  }, [analysis, simNodes]);

  // Handle Drag-and-Drop Coordinates inside SVG (supports transformed zoom/pan)
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y
      });
      return;
    }

    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    
    // Scale screen coordinate to SVG viewBox (1100x700)
    const rawX = ((e.clientX - rect.left) / rect.width) * 1100;
    const rawY = ((e.clientY - rect.top) / rect.height) * 700;
    
    // Transform coordinates back to node coordinate space considering Zoom and Pan
    const transformedX = (rawX - pan.x) / zoom;
    const transformedY = (rawY - pan.y) / zoom;
    
    setMousePos({ x: transformedX, y: transformedY });
  };

  const handleNodeMouseDown = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setDraggedNodeId(nodeId);
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement;
    if (target.id === 'svg-bg' || target.tagName === 'svg') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseUp = () => {
    setDraggedNodeId(null);
    setIsPanning(false);
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const zoomFactor = 1.08;
    const nextZoom = e.deltaY < 0 ? zoom * zoomFactor : zoom / zoomFactor;
    // Keep zoom within standard readable boundaries (0.2x macro to 6x micro view)
    setZoom(Math.max(0.2, Math.min(6, nextZoom)));
  };

  const toggleFilter = (type: string) => {
    setActiveFilters(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]);
  };

  const selectedNode = useMemo(() => {
    if (!hoveredId) return null;
    return simNodes.find(n => n.id === hoveredId) || null;
  }, [hoveredId, simNodes]);

  return (
    <div style={{ height: 'calc(100vh - 8rem)', display: 'flex', flexDirection: 'column' }} onMouseUp={handleMouseUp}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>Knowledge Network</h1>
          <p style={{ color: 'var(--text-muted)' }}>Interactive physics-based neural mapping of <span style={{ color: 'var(--primary-neon)' }}>{analysis?.stats?.totalModules || 0}</span> logic clusters.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {[
            { id: 'module', label: 'Modules', icon: Box, color: '#00F0FF' },
            { id: 'function', label: 'Functions', icon: Code2, color: '#FF00A8' },
            { id: 'class', label: 'Classes', icon: Layers, color: '#FFB400' },
            { id: 'variable', label: 'Variables', icon: Activity, color: '#00FF94' },
          ].map(f => (
            <div key={f.id} className={`filter-chip ${activeFilters.includes(f.id) ? 'active' : ''}`} onClick={() => toggleFilter(f.id)}>
              <f.icon size={14} /> {f.label}
            </div>
          ))}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '2rem', flex: 1, minHeight: 0 }}>
        {/* Interactive Physics Graph with Zoom/Pan */}
        <div className="glass-panel" style={{ borderRadius: '32px', position: 'relative', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(5, 8, 15, 0.65)' }}>
          <div style={{ position: 'absolute', top: '2rem', left: '2rem', zIndex: 10, width: '350px' }}>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: '1.25rem', top: '1.1rem', color: 'var(--text-muted)' }} />
              <input type="text" className="glass-input" placeholder="Search logic clusters..." style={{ paddingLeft: '3.25rem', background: 'rgba(0,0,0,0.6)', borderRadius: '16px' }} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>
          </div>

          {/* Guide Legend */}
          <div style={{ position: 'absolute', bottom: '2rem', left: '2rem', zIndex: 10, background: 'rgba(0,0,0,0.4)', padding: '0.75rem 1.25rem', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)', fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>🖱️ <span>Click & Drag background to Pan</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>🔍 <span>Scroll mouse wheel to Zoom</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>⚡ <span>Drag individual nodes to inspect</span></div>
          </div>

          {/* Floating Zoom & Pan Controls */}
          <div style={{ 
            position: 'absolute', 
            bottom: '2rem', 
            right: '2rem', 
            zIndex: 10, 
            display: 'flex', 
            alignItems: 'center',
            gap: '0.5rem',
            background: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '0.4rem',
            borderRadius: '12px'
          }}>
            <button 
              onClick={() => setZoom(z => Math.min(6, z * 1.15))}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: 'none',
                color: '#fff',
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
                fontFamily: 'monospace',
                fontSize: '1.1rem'
              }}
              title="Zoom In"
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--primary-neon)'; e.currentTarget.style.color = '#000'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; e.currentTarget.style.color = '#fff'; }}
            >
              +
            </button>
            <button 
              onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: 'none',
                color: 'var(--text-muted)',
                padding: '0 0.75rem',
                height: '32px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
                fontFamily: 'Space Grotesk, sans-serif',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}
              title="Reset Viewport"
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button 
              onClick={() => setZoom(z => Math.max(0.2, z / 1.15))}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: 'none',
                color: '#fff',
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
                fontFamily: 'monospace',
                fontSize: '1.1rem'
              }}
              title="Zoom Out"
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--primary-neon)'; e.currentTarget.style.color = '#000'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; e.currentTarget.style.color = '#fff'; }}
            >
              -
            </button>
          </div>

          <svg 
            ref={svgRef}
            width="100%" 
            height="100%" 
            viewBox="0 0 1100 700"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseUp}
            onMouseUp={handleMouseUp}
            style={{ 
              userSelect: 'none', 
              cursor: isPanning ? 'grabbing' : (draggedNodeId ? 'grabbing' : 'grab'),
              width: '100%',
              height: '100%'
            }}
          >
            <defs>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="6" result="blur"/>
                <feMerge>
                  <feMergeNode in="blur"/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
              <linearGradient id="linkGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="rgba(0, 240, 255, 0.15)" />
                <stop offset="50%" stopColor="rgba(255, 0, 168, 0.2)" />
                <stop offset="100%" stopColor="rgba(157, 0, 255, 0.15)" />
              </linearGradient>
            </defs>

            {/* Background invisible rect to capture pan clicks/drag events anywhere on empty space */}
            <rect 
              id="svg-bg"
              width="1100" 
              height="700" 
              fill="transparent" 
              style={{ pointerEvents: 'all' }}
            />

            {/* Scale/Pan Transformed Viewport Group */}
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              
              {/* Neural Links (Spring lines) */}
              {simulatedLinks.map((link, i) => (
                <line 
                  key={`link-${i}`} 
                  x1={link.source.x} 
                  y1={link.source.y} 
                  x2={link.target.x} 
                  y2={link.target.y} 
                  stroke="url(#linkGradient)" 
                  strokeWidth={hoveredId === link.source.id || hoveredId === link.target.id ? "2.5" : "1.2"} 
                  strokeOpacity={hoveredId === link.source.id || hoveredId === link.target.id ? "0.9" : "0.45"}
                  style={{ transition: 'stroke-width 0.2s, stroke-opacity 0.2s' }}
                />
              ))}

              {/* Glowing signal pulses flowing along links */}
              {simulatedLinks.slice(0, 30).map((link, i) => {
                // Add a floating signal pulse to random links
                if (i % 3 !== 0) return null;
                return (
                  <circle key={`pulse-${i}`} r="3" fill="#00F0FF">
                    <animateMotion 
                      dur={`${2 + (i % 3) * 1.5}s`} 
                      repeatCount="indefinite"
                      path={`M ${link.source.x} ${link.source.y} L ${link.target.x} ${link.target.y}`}
                    />
                  </circle>
                );
              })}

              {/* Neural Nodes */}
              {simNodes.map((node, i) => {
                const isModule = node.type === 'module';
                const color = node.type === 'module' 
                  ? '#00F0FF' 
                  : node.type === 'class' 
                    ? '#FFB400' 
                    : node.type === 'variable' 
                      ? '#00FF94' 
                      : '#FF00A8';

                const radius = isModule ? 9 : node.type === 'class' ? 6.5 : node.type === 'variable' ? 4 : 5.5;
                const isHovered = hoveredId === node.id;

                return (
                  <g 
                    key={node.id} 
                    onMouseEnter={() => setHoveredId(node.id)} 
                    onMouseLeave={() => setHoveredId(null)}
                    onMouseDown={(e) => handleNodeMouseDown(node.id, e)}
                    style={{ cursor: draggedNodeId === node.id ? 'grabbing' : 'grab' }}
                  >
                    {/* Outer Orbit Halo Ring for Modules */}
                    {isModule && (
                      <circle 
                        cx={node.x} 
                        cy={node.y} 
                        r="18" 
                        fill="none" 
                        stroke={`${color}22`} 
                        strokeWidth="1.5"
                        strokeDasharray="4 2"
                      >
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          from={`0 ${node.x} ${node.y}`}
                          to={`360 ${node.x} ${node.y}`}
                          dur="10s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}

                    {/* Node Glow Shadow Backing */}
                    {isHovered && (
                      <circle 
                        cx={node.x} 
                        cy={node.y} 
                        r={radius + 6} 
                        fill={color} 
                        opacity="0.3"
                        filter="url(#glow)"
                      />
                    )}

                    {/* Core Node Dot */}
                    <circle 
                      cx={node.x} 
                      cy={node.y} 
                      r={isHovered ? radius + 2.5 : radius} 
                      fill={isHovered ? color : `${color}cc`} 
                      stroke="rgba(0,0,0,0.6)"
                      strokeWidth="1.5"
                      style={{ transition: 'r 0.15s, fill 0.15s' }}
                    />

                    {/* Floating Text Labels */}
                    {(isHovered || isModule) && (
                      <text 
                        x={node.x + 14} 
                        y={node.y + 4} 
                        fill={isHovered ? '#fff' : 'rgba(255,255,255,0.7)'} 
                        style={{ 
                          fontSize: isModule ? '11.5px' : '10px', 
                          fontWeight: isHovered ? 800 : 600, 
                          pointerEvents: 'none', 
                          fontFamily: 'monospace',
                          textShadow: '0 1px 4px rgba(0,0,0,0.9), 0 0 10px rgba(0,0,0,0.9)'
                        }}
                      >
                        {node.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {/* Stats & Interactive Tooltip Sidebar */}
        <div className="glass-panel" style={{ borderRadius: '32px', padding: '2rem', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '1.5rem', overflowY: 'auto' }}>
          
          {selectedNode ? (
            // Holographic Tooltip Details on Hover
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', height: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '1rem' }}>
                <div style={{ 
                  width: '38px', height: '38px', 
                  background: selectedNode.type === 'module' ? 'rgba(0, 240, 255, 0.1)' : 'rgba(255, 0, 168, 0.1)', 
                  borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: selectedNode.type === 'module' ? '#00F0FF' : '#FF00A8'
                }}>
                  {selectedNode.type === 'module' ? <Box size={18} /> : <Code2 size={18} />}
                </div>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 800, textTransform: 'uppercase' }}>
                    {selectedNode.type} Entity
                  </div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#fff', wordBreak: 'break-all' }}>
                    {selectedNode.label}
                  </div>
                </div>
              </div>

              <div style={{ background: 'rgba(0,0,0,0.25)', padding: '1rem', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.04)', fontSize: '0.82rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div>
                  <span style={{ color: 'var(--text-muted)', display: 'block', marginBottom: '0.2rem', fontSize: '0.75rem', fontWeight: 700 }}>LOCATION</span>
                  <code style={{ color: '#00F0FF', wordBreak: 'break-all', display: 'block', fontSize: '0.78rem', background: 'rgba(0,0,0,0.15)', padding: '0.4rem', borderRadius: '6px' }}>
                    {selectedNode.filePath || 'internal/system'}
                  </code>
                </div>
                {selectedNode.line !== undefined && (
                  <div>
                    <span style={{ color: 'var(--text-muted)', display: 'block', marginBottom: '0.2rem', fontSize: '0.75rem', fontWeight: 700 }}>LINE NUMBER</span>
                    <span style={{ color: '#fff', fontWeight: 700 }}>Line {selectedNode.line}</span>
                  </div>
                )}
              </div>

              {/* Dynamic connection counts */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '0.85rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: 900, color: '#FFB400' }}>
                    {simulatedLinks.filter(l => l.source.id === selectedNode.id).length}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 800 }}>OUTGOING CALLS</div>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '0.85rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: 900, color: '#00FF94' }}>
                    {simulatedLinks.filter(l => l.target.id === selectedNode.id).length}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 800 }}>INCOMING REFS</div>
                </div>
              </div>

              <div style={{ marginTop: 'auto', padding: '1rem', background: 'rgba(255, 0, 168, 0.05)', borderRadius: '16px', border: '1px solid rgba(255, 0, 168, 0.1)', fontSize: '0.8rem', lineHeight: 1.4, color: 'rgba(255, 255, 255, 0.8)' }}>
                💡 <b>Spring Physics Tip:</b> Grab this node and shake it to disperse clustered logic blocks and visualize relative node weights!
              </div>
            </div>
          ) : (
            // Default Overview Panel
            <>
              <h3 className="tech-font" style={{ fontSize: '1.25rem', fontWeight: 800 }}>Entity Overview</h3>
              {[
                { label: 'Modules', count: analysis?.stats?.totalModules || 0, icon: Box, color: '#00F0FF' },
                { label: 'Functions', count: analysis?.stats?.totalFunctions || 0, icon: Code2, color: '#FF00A8' },
                { label: 'Classes', count: analysis?.stats?.totalClasses || 0, icon: Layers, color: '#FFB400' },
                { label: 'Variables', count: analysis?.stats?.totalVariables || 0, icon: Activity, color: '#00FF94' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', background: 'rgba(255,255,255,0.03)', padding: '1.25rem', borderRadius: '18px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ width: '40px', height: '40px', background: `${item.color}15`, borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: item.color }}><item.icon size={20} /></div>
                  <div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 900 }}>{item.count}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700 }}>{item.label}</div>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 'auto', padding: '1.5rem', background: 'rgba(0, 240, 255, 0.05)', borderRadius: '20px', border: '1px solid rgba(0, 240, 255, 0.1)' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--primary-neon)', marginBottom: '0.5rem' }}>INDEX COVERAGE</div>
                <div style={{ height: '8px', background: 'rgba(0,0,0,0.3)', borderRadius: '10px', overflow: 'hidden' }}>
                  <motion.div initial={{ width: 0 }} animate={{ width: '85%' }} transition={{ duration: 1 }} style={{ height: '100%', background: 'var(--primary-neon)', boxShadow: '0 0 10px var(--primary-neon)' }} />
                </div>
                <div style={{ textAlign: 'right', fontSize: '0.7rem', marginTop: '0.5rem', color: 'var(--primary-neon)', fontWeight: 800 }}>85% SCANNED</div>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
};
