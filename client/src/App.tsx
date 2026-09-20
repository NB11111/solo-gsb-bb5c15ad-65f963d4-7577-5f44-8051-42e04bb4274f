import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  useEdgesState,
  useNodesState,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler
} from 'reactflow';
import 'reactflow/dist/style.css';
import { api } from './api';
import { ArgumentNode, nodeTypes, type ArgumentNodeData } from './components/ArgumentNode';
import { SidePanel, graphToDocument, type SensitivitySelection, type TraceSelection } from './components/SidePanel';
import { ReplayBar } from './components/ReplayBar';
import { buildRoundDecomposition } from './replay';
import { computeLayout, layoutFingerprint, type LayoutResult } from './layout';
import type {
  GraphDocument,
  GraphNode,
  GraphEdge,
  InfluencePath,
  PropagateOptions,
  PropagateResult,
  SensitivityResult,
  Stance,
  TraceResult
} from '../../shared/graph';
import { stableSample, oscillatingSample } from './samples';

const DEFAULT_OPTIONS: PropagateOptions = { threshold: 0.001, maxIterations: 200, lambda: 0.8 };
const DEFAULT_TRACE_SELECTION: TraceSelection = { startNodeId: '', targetNodeId: '', maxHops: 8 };

type EdgeDecorMode = 'plain' | 'cycle' | 'trace-active';

const documentToFlow = (graph: GraphDocument): { nodes: Node<ArgumentNodeData>[]; edges: Edge[] } => ({
  nodes: graph.nodes.map((node) => ({
    id: node.id,
    type: 'argument',
    position: node.position,
    data: {
      label: node.label,
      kind: node.kind,
      initialBelief: node.initialBelief,
      anchored: node.anchored,
      layoutLocked: Boolean(node.layoutLocked)
    }
  })),
  edges: graph.edges.map((edge) => makeEdge(edge))
});

function makeEdge(edge: GraphEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: `${edge.stance === 'support' ? '支持' : '反驳'} ${Math.round(edge.weight * 100)}%`,
    animated: false,
    data: { stance: edge.stance, weight: edge.weight },
    className: `stance-${edge.stance}`,
    markerEnd: { type: MarkerType.ArrowClosed }
  };
}

/** 按当前分析视图重绘连线：追踪优先于负反馈环；选中路径加粗动画，候选路径细线高亮。 */
function decorateEdge(
  edge: Edge,
  mode: EdgeDecorMode,
  activeRunningScore?: number
): Edge {
  const stance = (edge.data?.stance as Stance) ?? 'support';
  const weight = Number(edge.data?.weight ?? 0.6);
  const baseLabel = `${stance === 'support' ? '支持' : '反驳'} ${Math.round(weight * 100)}%`;
  const className = [
    `stance-${stance}`,
    mode === 'cycle' ? 'cycle-edge' : '',
    mode === 'trace-active' ? 'trace-path-edge trace-active-edge' : ''
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...edge,
    label:
      mode === 'trace-active' && activeRunningScore !== undefined
        ? `${baseLabel} · 累计 ${activeRunningScore >= 0 ? '+' : ''}${activeRunningScore.toFixed(2)}`
        : baseLabel,
    className,
    animated: mode === 'cycle' || mode === 'trace-active',
    style: mode === 'plain' ? undefined : { strokeWidth: mode === 'trace-active' ? 4.5 : 3.4 },
    markerEnd: { type: MarkerType.ArrowClosed }
  };
}

let localCounter = 0;
const createId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(localCounter += 1)}`;

/** 用第 round 轮的轨迹值刷新节点显示（纯视图更新，不保存、不重新计算）。 */
function decorateNodesForRound(
  current: Node<ArgumentNodeData>[],
  result: PropagateResult,
  round: number,
  cycleNodeIds: Set<string>
): Node<ArgumentNodeData>[] {
  return current.map((node) => {
    const trace = result.traces[node.id];
    if (!trace || trace.length === 0) {
      return { ...node, data: { ...node.data, displayBelief: undefined, roundDelta: undefined, inCycle: false } };
    }
    const clamped = Math.max(0, Math.min(round, trace.length - 1));
    const value = trace[clamped];
    return {
      ...node,
      data: {
        ...node.data,
        displayBelief: value,
        roundDelta: clamped > 0 ? value - trace[clamped - 1] : undefined,
        inCycle: cycleNodeIds.has(node.id)
      }
    };
  });
}

export default function App() {
  const [documentName, setDocumentName] = useState('我的论证图');
  const [nodes, setNodes, onNodesChange] = useNodesState<ArgumentNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [options, setOptions] = useState<PropagateOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<PropagateResult | null>(null);
  const [replayRound, setReplayRound] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [status, setStatus] = useState('正在加载…');
  const [busy, setBusy] = useState(false);
  const [sensitivitySelection, setSensitivitySelection] = useState<SensitivitySelection>({
    edgeId: '',
    targetNodeId: ''
  });
  const [sensitivityResult, setSensitivityResult] = useState<SensitivityResult | null>(null);
  const [sensitivityScanning, setSensitivityScanning] = useState(false);
  const [sensitivityStatus, setSensitivityStatus] = useState('');
  const [traceSelection, setTraceSelection] = useState<TraceSelection>(DEFAULT_TRACE_SELECTION);
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null);
  const [traceTracing, setTraceTracing] = useState(false);
  const [traceStatus, setTraceStatus] = useState('');
  const [traceActiveIndex, setTraceActiveIndex] = useState(0);
  // 一键整理布局预览：只暂存计算结果，不写画布、不写 SQLite；指纹用于在任何图编辑后使其失效。
  const [layoutPreview, setLayoutPreview] = useState<{
    fingerprint: string;
    result: LayoutResult;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const scheduleSave = useCallback(
    (nextNodes = nodes, nextEdges = edges, immediate = false) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      const run = () => {
        setStatus('正在保存…');
        api
          .saveGraph(graphToDocument(documentName, nextNodes, nextEdges))
          .then(() => setStatus('已自动保存到 SQLite'))
          .catch((error: Error) => setStatus(`保存失败：${error.message}`));
      };
      if (immediate) run();
      else saveTimerRef.current = window.setTimeout(run, 700);
    },
    [documentName, edges, nodes]
  );

  useEffect(() => {
    api
      .getGraph()
      .then(({ graph }) => {
        const flow = documentToFlow(graph);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        setDocumentName(graph.name ?? '我的论证图');
        setStatus('已从 SQLite 载入');
      })
      .catch((error: Error) => setStatus(`加载失败：${error.message}`));
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
    // 仅在启动时加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 图的任何增删改动都会使上一次扫描结果失效（扫描图与当前画布不再一致）。
  const invalidateSensitivity = useCallback(() => {
    setSensitivityResult(null);
    setSensitivityStatus('');
  }, []);

  // 图编辑或传播参数编辑都会使追踪路径失效（路径集合与带符号乘积都可能变化）。
  const invalidateTrace = useCallback(() => {
    setTraceResult(null);
    setTraceStatus('');
    setTraceActiveIndex(0);
  }, []);

  // 整理布局预览只对生成时的图有效：任何图编辑（含锁定开关、拖拽、增删）都让预览失效。
  const clearLayoutPreview = useCallback(() => {
    setLayoutPreview(null);
  }, []);

  // 取消预览：只清空预览状态，画布节点坐标与 SQLite 均保持不变。
  const cancelLayoutPreview = useCallback(() => setLayoutPreview(null), []);

  // 指纹比对兜底：图被编辑而当前画布指纹与预览生成时不同，则丢弃过期预览。
  useEffect(() => {
    if (!layoutPreview) return;
    const fingerprint = layoutFingerprint(graphToDocument(documentName, nodes, edges));
    if (fingerprint !== layoutPreview.fingerprint) setLayoutPreview(null);
  }, [layoutPreview, documentName, nodes, edges]);

  const clearAnalysis = useCallback(
    (nextNodes = nodes, nextEdges = edges) => {
      setResult(null);
      setReplayRound(0);
      setPlaying(false);
      invalidateSensitivity();
      invalidateTrace();
      setNodes(
        nextNodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            displayBelief: undefined,
            roundDelta: undefined,
            inCycle: false,
            inTrace: false,
            traceStart: false,
            traceTarget: false
          }
        }))
      );
      setEdges(nextEdges.map((edge) => decorateEdge({ ...edge, animated: false, style: undefined }, 'plain')));
    },
    [edges, nodes, setEdges, setNodes, invalidateSensitivity, invalidateTrace]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const edge = makeEdge({
        id: createId('edge'),
        source: connection.source,
        target: connection.target,
        stance: 'support',
        weight: 0.6
      });
      const nextEdges = [...edges, edge];
      clearAnalysis(nodes, nextEdges);
      clearLayoutPreview();
      scheduleSave(nodes, nextEdges, true);
    },
    [clearAnalysis, clearLayoutPreview, edges, nodes, scheduleSave, setEdges]
  );

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (_event, node) => {
      // 位置变化不清除计算结果，但需要持久化布局；手动移动节点后整理预览即过期。
      const nextNodes = nodes.map((item) => (item.id === node.id ? node : item));
      clearLayoutPreview();
      scheduleSave(nextNodes, edges);
    },
    [clearLayoutPreview, edges, nodes, scheduleSave]
  );

  const addNode = (kind: 'claim' | 'evidence') => {
    const id = createId(kind);
    const node: Node<ArgumentNodeData> = {
      id,
      type: 'argument',
      position: { x: 120 + Math.random() * 220, y: 90 + Math.random() * 260 },
      data: {
        label: kind === 'evidence' ? `证据 ${nodes.length + 1}` : `观点 ${nodes.length + 1}`,
        kind,
        initialBelief: kind === 'evidence' ? 0.8 : 0.5,
        anchored: false
      }
    };
    const nextNodes = [...nodes, node];
    clearAnalysis(nextNodes, edges);
    clearLayoutPreview();
    scheduleSave(nextNodes, edges, true);
  };

  const updateNode = (id: string, patch: Partial<ArgumentNodeData>) => {
    const nextNodes = nodes.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
    );
    clearAnalysis(nextNodes, edges);
    clearLayoutPreview();
    scheduleSave(nextNodes, edges);
  };

  // 位置锁定开关本身是图编辑：持久化锁定标记，但不清除传播分析结果；任何进行中的整理预览立即失效。
  const toggleLayoutLock = (id: string, locked: boolean) => {
    const nextNodes = nodes.map((node) =>
      node.id === id
        ? { ...node, data: { ...node.data, layoutLocked: locked } }
        : node
    );
    clearLayoutPreview();
    scheduleSave(nextNodes, edges);
  };

  const updateEdge = (id: string, patch: { weight?: number; stance?: Stance }) => {
    const nextEdges = edges.map((edge) =>
      edge.id === id ? decorateEdge({ ...edge, data: { ...edge.data, ...patch } }, 'plain') : edge
    );
    clearAnalysis(nodes, nextEdges);
    clearLayoutPreview();
    scheduleSave(nodes, nextEdges);
  };

  const deleteSelection = useCallback(() => {
    let nextNodes = nodes;
    let nextEdges = edges;
    if (selectedNodeId) {
      nextNodes = nodes.filter((node) => node.id !== selectedNodeId);
      nextEdges = edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId);
      setSelectedNodeId(null);
    } else if (selectedEdgeId) {
      nextEdges = edges.filter((edge) => edge.id !== selectedEdgeId);
      setSelectedEdgeId(null);
    } else {
      return;
    }
    clearAnalysis(nextNodes, nextEdges);
    clearLayoutPreview();
    scheduleSave(nextNodes, nextEdges, true);
  }, [
    clearAnalysis,
    clearLayoutPreview,
    edges,
    nodes,
    scheduleSave,
    selectedEdgeId,
    selectedNodeId,
    setEdges,
    setNodes
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      // 预览态下 Delete 不删除任何东西；Escape 等价于点击取消，不改写画布。
      if (layoutPreview && event.key === 'Escape' && !typing) {
        cancelLayoutPreview();
        return;
      }
      if (event.key === 'Delete' && !typing && !layoutPreview) {
        deleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelection, layoutPreview, cancelLayoutPreview]);

  const runPropagation = async () => {
    setBusy(true);
    setStatus('正在迭代传播…');
    try {
      // 先保存，确保后端计算的是当前画布。
      await api.saveGraph(graphToDocument(documentName, nodes, edges));
      const { result: nextResult } = await api.propagate(options);
      const cycleNodeIds = new Set(nextResult.cycles.flatMap((cycle) => cycle.nodeIds));
      // 重新计算后，旧的路径追踪高亮不再代表“最近一次分析”，先清空，由统一装饰 effect 回落到环高亮。
      invalidateTrace();
      setResult(nextResult);
      setPlaying(false);
      setReplayRound(nextResult.iterations);
      setNodes((current) => decorateNodesForRound(current, nextResult, nextResult.iterations, cycleNodeIds));
      setStatus(nextResult.message);
    } catch (error) {
      setStatus(`计算失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  // 回放只切换展示的轮次：不修改图、不保存、不重新计算。
  const goToRound = useCallback(
    (round: number) => {
      if (!result) return;
      const clamped = Math.max(0, Math.min(result.iterations, Math.round(round)));
      setReplayRound(clamped);
      const cycleNodeIds = new Set(result.cycles.flatMap((cycle) => cycle.nodeIds));
      setNodes((current) => decorateNodesForRound(current, result, clamped, cycleNodeIds));
    },
    [result, setNodes]
  );

  // 播放：收敛结果播到停止轮即停；振荡结果在最后一个周期内循环。
  useEffect(() => {
    if (!playing || !result) return;
    const loopable = Boolean(result.oscillating && result.detectedPeriod);
    if (replayRound >= result.iterations && !loopable) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      if (replayRound >= result.iterations && loopable) {
        goToRound(Math.max(0, result.iterations - (result.detectedPeriod ?? 1) + 1));
      } else {
        goToRound(replayRound + 1);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [playing, replayRound, result, goToRound]);

  const togglePlay = () => {
    if (!result) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // 收敛结果停在末轮时再按播放，从第 0 轮重新播放。
    const loopable = Boolean(result.oscillating && result.detectedPeriod);
    if (replayRound >= result.iterations && !loopable) goToRound(0);
    setPlaying(true);
  };

  // 一键整理布局：仅在前端内存中计算并暂存预览，绝不触碰画布或 SQLite。
  const previewLayout = () => {
    const document = graphToDocument(documentName, nodes, edges);
    const result = computeLayout(
      document.nodes.map((node) => ({
        id: node.id,
        position: node.position,
        layoutLocked: Boolean(node.layoutLocked)
      })),
      document.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }))
    );
    setLayoutPreview({ fingerprint: layoutFingerprint(document), result });
  };

  // 确认：一次性把预览坐标应用到画布，并沿用既有保存逻辑（防抖 PUT /api/graph）。
  const applyLayoutPreview = () => {
    if (!layoutPreview) return;
    const { positions } = layoutPreview.result;
    const nextNodes = nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, position: { x: position.x, y: position.y } } : node;
    });
    setNodes(nextNodes);
    setLayoutPreview(null);
    scheduleSave(nextNodes, edges, true);
  };

  const loadDocument = (graph: GraphDocument, immediateSave = true, nextOptions?: PropagateOptions) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const flow = documentToFlow(graph);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setDocumentName(graph.name ?? '导入的论证图');
    setResult(null);
    setReplayRound(0);
    setPlaying(false);
    invalidateSensitivity();
    setSensitivitySelection({ edgeId: '', targetNodeId: '' });
    invalidateTrace();
    setTraceSelection(DEFAULT_TRACE_SELECTION);
    clearLayoutPreview();
    if (nextOptions) setOptions(nextOptions);
    if (immediateSave) {
      setStatus('正在导入…');
      api
        .saveGraph(graph)
        .then(() => setStatus('JSON 已导入并保存'))
        .catch((error: Error) => setStatus(`导入失败：${error.message}`));
    }
  };

  const exportJson = () => {
    const graphDocument = graphToDocument(documentName, nodes, edges);
    const blob = new Blob([JSON.stringify(graphDocument, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${documentName || 'argument-graph'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importJsonFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as GraphDocument | { graph: GraphDocument };
      const graph = 'graph' in parsed ? parsed.graph : parsed;
      // 后端执行严格校验并返回规范化文档。
      const saved = await api.saveGraph(graph);
      loadDocument(saved.graph, false);
      setStatus('JSON 已导入并保存');
    } catch (error) {
      setStatus(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId),
    [edges, selectedEdgeId]
  );

  // 被扫描的边或目标节点删除后，清掉失效选择；不自动重选，避免跑出用户意料之外的扫描。
  useEffect(() => {
    setSensitivitySelection((current) => {
      const edgeExists = !current.edgeId || edges.some((edge) => edge.id === current.edgeId);
      const nodeExists = !current.targetNodeId || nodes.some((node) => node.id === current.targetNodeId);
      if (edgeExists && nodeExists) return current;
      return {
        edgeId: edgeExists ? current.edgeId : '',
        targetNodeId: nodeExists ? current.targetNodeId : ''
      };
    });
  }, [edges, nodes]);

  // 选中一条连线后，默认把扫描目标填为该连线的目标节点，减少一次手动选择。
  useEffect(() => {
    if (!selectedEdge) return;
    setSensitivitySelection((current) => ({
      edgeId: selectedEdge.id,
      targetNodeId: current.targetNodeId || selectedEdge.target
    }));
  }, [selectedEdge]);

  const runSensitivityScan = useCallback(async () => {
    if (!sensitivitySelection.edgeId || !sensitivitySelection.targetNodeId) return;
    setSensitivityScanning(true);
    setSensitivityStatus('正在服务端内存中逐点计算（不保存图）…');
    try {
      // 直接提交当前画布：扫描只在服务端内存中进行，不触发任何持久化。
      const { scan } = await api.scanEdgeWeight({
        graph: graphToDocument(documentName, nodes, edges),
        edgeId: sensitivitySelection.edgeId,
        targetNodeId: sensitivitySelection.targetNodeId,
        options
      });
      setSensitivityResult(scan);
      setSensitivityStatus(scan.message);
    } catch (error) {
      setSensitivityResult(null);
      setSensitivityStatus(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSensitivityScanning(false);
    }
  }, [documentName, edges, nodes, options, sensitivitySelection.edgeId, sensitivitySelection.targetNodeId]);

  const sensitivityEdgeLabel = useMemo(() => {
    const edge = edges.find((item) => item.id === sensitivitySelection.edgeId);
    if (!edge) return '所选连线';
    const labelById = new Map(nodes.map((node) => [node.id, node.data.label] as const));
    return `${labelById.get(edge.source) ?? edge.source} → ${labelById.get(edge.target) ?? edge.target}`;
  }, [edges, nodes, sensitivitySelection.edgeId]);

  const sensitivityTargetLabel = useMemo(
    () => nodes.find((node) => node.id === sensitivitySelection.targetNodeId)?.data.label ?? '目标节点',
    [nodes, sensitivitySelection.targetNodeId]
  );

  // 选中节点时，本地重算「当前轮 → 下一轮」的可核对分解。
  const decomposition = useMemo(() => {
    if (!result || !selectedNode) return null;
    return buildRoundDecomposition(selectedNode, nodes, edges, result, replayRound);
  }, [result, selectedNode, nodes, edges, replayRound]);

  const handleOptionsChange = useCallback(
    (nextOptions: PropagateOptions) => {
      setOptions(nextOptions);
      // 扫描沿用当前传播参数：参数一变，旧曲线对应的参数就过期了。
      invalidateSensitivity();
      // 路径分数虽不直接使用传播参数，但追踪与传播视图共用参数语境，参数编辑后一并失效。
      invalidateTrace();
    },
    [invalidateSensitivity, invalidateTrace]
  );

  const runTrace = useCallback(async () => {
    if (!traceSelection.startNodeId || !traceSelection.targetNodeId) return;
    setTraceTracing(true);
    setTraceStatus('正在服务端枚举有向简单路径（不保存图）…');
    try {
      // 直接提交当前画布：追踪只在服务端内存中枚举，不触发任何持久化。
      const { trace } = await api.traceInfluence({
        graph: graphToDocument(documentName, nodes, edges),
        startNodeId: traceSelection.startNodeId,
        targetNodeId: traceSelection.targetNodeId,
        maxHops: traceSelection.maxHops
      });
      setTraceResult(trace);
      setTraceActiveIndex(0);
      setTraceStatus(trace.message);
    } catch (error) {
      setTraceResult(null);
      setTraceStatus(`追踪失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTraceTracing(false);
    }
  }, [
    documentName,
    edges,
    nodes,
    traceSelection.maxHops,
    traceSelection.startNodeId,
    traceSelection.targetNodeId
  ]);

  // 当前要在画布上高亮的路径（追踪结果中的第 activeIndex 条）。
  const activeTracePath: InfluencePath | null = useMemo(() => {
    if (!traceResult || traceResult.paths.length === 0) return null;
    const index = Math.max(0, Math.min(traceActiveIndex, traceResult.paths.length - 1));
    return traceResult.paths[index] ?? null;
  }, [traceResult, traceActiveIndex]);

  // 起点或目标节点被删除后，清掉失效追踪选择。
  useEffect(() => {
    setTraceSelection((current) => {
      const startExists =
        !current.startNodeId || nodes.some((node) => node.id === current.startNodeId && node.data.kind === 'evidence');
      const targetExists = !current.targetNodeId || nodes.some((node) => node.id === current.targetNodeId);
      if (startExists && targetExists) return current;
      return {
        startNodeId: startExists ? current.startNodeId : '',
        targetNodeId: targetExists ? current.targetNodeId : '',
        maxHops: current.maxHops
      };
    });
  }, [nodes]);

  // 追踪高亮（优先）/负反馈环高亮 / 无高亮：由最近一次分析结果统一驱动，保证连线样式幂等。
  const cycleEdgeIds = useMemo(
    () => new Set((result?.cycles ?? []).flatMap((cycle) => cycle.edgeIds)),
    [result]
  );
  useEffect(() => {
    setEdges((current) =>
      current.map((edge) => {
        if (activeTracePath) {
          const stepIndex = activeTracePath.edgeIds.indexOf(edge.id);
          if (stepIndex >= 0) {
            return decorateEdge(edge, 'trace-active', activeTracePath.steps[stepIndex]?.runningScore);
          }
          return decorateEdge(edge, 'plain');
        }
        if (result) return decorateEdge(edge, cycleEdgeIds.has(edge.id) ? 'cycle' : 'plain');
        return decorateEdge(edge, 'plain');
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTracePath, result, cycleEdgeIds]);

  // 节点上的追踪标记（起点/目标/途经）；不动可信度着色，回放与追踪可以同时可见。
  useEffect(() => {
    if (!activeTracePath) {
      setNodes((current) => {
        if (current.every((node) => !node.data.inTrace && !node.data.traceStart && !node.data.traceTarget)) {
          return current;
        }
        return current.map((node) => ({
          ...node,
          data: { ...node.data, inTrace: false, traceStart: false, traceTarget: false }
        }));
      });
      return;
    }
    const traceNodeIds = new Set(activeTracePath.nodeIds);
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          inTrace: traceNodeIds.has(node.id),
          traceStart: node.id === activeTracePath.nodeIds[0],
          traceTarget: node.id === activeTracePath.nodeIds[activeTracePath.nodeIds.length - 1]
        }
      }))
    );
  }, [activeTracePath, setNodes]);

  // 预览中的画布：把暂存坐标叠加到节点上（不改 nodes 状态），锁定节点同时加上标记。
  const displayNodes = useMemo(() => {
    if (!layoutPreview) return nodes;
    const { positions } = layoutPreview.result;
    return nodes.map((node) => {
      const position = positions.get(node.id);
      return {
        ...node,
        position: position ? { x: position.x, y: position.y } : node.position,
        draggable: false,
        connectable: false,
        data: { ...node.data, layoutPreviewActive: true }
      };
    });
  }, [layoutPreview, nodes]);

  const lockedNodeCount = useMemo(() => nodes.filter((node) => node.data.layoutLocked).length, [nodes]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>论证稳定性沙盘</h1>
          <input
            className="document-name"
            value={documentName}
            onChange={(event) => setDocumentName(event.target.value)}
            onBlur={() => scheduleSave(nodes, edges, true)}
          />
        </div>
        <div className="toolbar">
          <button onClick={() => addNode('claim')}>＋ 观点</button>
          <button onClick={() => addNode('evidence')}>＋ 证据</button>
          <button
            onClick={previewLayout}
            disabled={busy || nodes.length === 0 || Boolean(layoutPreview)}
            title="压缩强连通分量为 DAG、最长路径分层、4 轮重心排序；锁定节点坐标保持不变"
          >
            {layoutPreview ? '整理预览中…' : '🧭 一键整理布局'}
          </button>
          <button className="primary" disabled={busy || nodes.length === 0} onClick={runPropagation}>
            {busy ? '计算中…' : '运行稳定性分析'}
          </button>
          <button onClick={() => loadDocument(stableSample, true, DEFAULT_OPTIONS)}>载入稳定示例</button>
          <button onClick={() => loadDocument(oscillatingSample, true, { ...DEFAULT_OPTIONS, lambda: 1 })}>
            载入振荡示例
          </button>
          <button onClick={exportJson} disabled={nodes.length === 0}>
            导出 JSON
          </button>
          <button onClick={() => fileInputRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importJsonFile(file);
              event.target.value = '';
            }}
          />
        </div>
      </header>

      <main className="workspace">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            nodesDraggable={!layoutPreview}
            nodesConnectable={!layoutPreview}
            elementsSelectable={!layoutPreview}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
              // 点击证据自动设为追踪起点，点击观点自动设为追踪目标，减少手动选择。
              if (node.data.kind === 'evidence') {
                setTraceSelection((current) => ({
                  ...current,
                  startNodeId: node.id,
                  targetNodeId: current.targetNodeId === node.id ? '' : current.targetNodeId
                }));
              } else {
                setTraceSelection((current) => ({
                  ...current,
                  targetNodeId: node.id,
                  startNodeId: current.startNodeId === node.id ? '' : current.startNodeId
                }));
              }
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            onNodesDelete={(deleted) => {
              if (deleted.some((node) => node.id === selectedNodeId)) setSelectedNodeId(null);
            }}
            onEdgesDelete={(deleted) => {
              if (deleted.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null);
            }}
            fitView
            deleteKeyCode={null}
            connectionLineStyle={{ stroke: '#2563eb' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#c7d2fe" />
            <Controls />
          </ReactFlow>
          {layoutPreview && (
            <div className="layout-preview-banner" role="dialog" aria-label="整理布局预览">
              <div className="layout-preview-title">🧭 整理布局预览（尚未保存）</div>
              <div className="layout-preview-stats">
                <span>
                  连线交叉：<strong>{layoutPreview.result.crossingsBefore}</strong> →{' '}
                  <strong className={
                    layoutPreview.result.crossingsAfter < layoutPreview.result.crossingsBefore
                      ? 'layout-stat-good'
                      : ''
                  }>
                    {layoutPreview.result.crossingsAfter}
                  </strong>
                </span>
                <span>
                  总位移：<strong>{Math.round(layoutPreview.result.totalDisplacement)}</strong> px
                </span>
                <span className="layout-preview-hint">
                  {lockedNodeCount} 个锁定节点坐标完全不变；任何图编辑都会取消本预览
                </span>
              </div>
              <div className="layout-preview-actions">
                <button className="primary" onClick={applyLayoutPreview}>
                  确认应用并保存
                </button>
                <button onClick={cancelLayoutPreview}>取消（不改写画布）</button>
              </div>
            </div>
          )}
          <div className="canvas-footer">
            {result ? (
              <ReplayBar
                result={result}
                round={replayRound}
                playing={playing}
                onSeek={goToRound}
                onTogglePlay={togglePlay}
              />
            ) : (
              <span className="canvas-footer-spacer" />
            )}
            <div className={`status-pill ${result?.oscillating ? 'bad' : result?.converged ? 'good' : ''}`}>
              {status}
            </div>
          </div>
        </div>

        <SidePanel
          options={options}
          onOptionsChange={handleOptionsChange}
          result={result}
          selection={{ node: selectedNode, edge: selectedEdge }}
          decomposition={decomposition}
          onUpdateNode={updateNode}
          onToggleLayoutLock={toggleLayoutLock}
          onUpdateEdge={updateEdge}
          onDeleteSelection={deleteSelection}
          nodes={nodes}
          edges={edges}
          sensitivity={{
            selection: sensitivitySelection,
            onSelectionChange: (patch) =>
              setSensitivitySelection((current) => ({ ...current, ...patch })),
            scan: sensitivityResult,
            scanning: sensitivityScanning,
            status: sensitivityStatus,
            onRun: runSensitivityScan,
            onClose: () => setSensitivityResult(null),
            edgeLabel: sensitivityEdgeLabel,
            targetLabel: sensitivityTargetLabel
          }}
          trace={{
            selection: traceSelection,
            onSelectionChange: (patch) => setTraceSelection((current) => ({ ...current, ...patch })),
            result: traceResult,
            tracing: traceTracing,
            status: traceStatus,
            activeIndex: activeTracePath
              ? Math.max(0, Math.min(traceActiveIndex, traceResult?.paths.length ?? 1))
              : 0,
            onActiveIndexChange: setTraceActiveIndex,
            onRun: runTrace,
            onClose: invalidateTrace
          }}
        />
      </main>
    </div>
  );
}
