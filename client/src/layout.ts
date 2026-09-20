import type { GraphDocument, Position } from '../../shared/graph';

/**
 * 一键整理布局：
 * 1. Tarjan 求强连通分量（SCC），把分量压缩为 DAG；
 * 2. 在 DAG 上按最长路径分层（rank）；
 * 3. 固定执行 4 轮（每轮正向 + 逆向一遍）重心排序，减少跨层连线交叉，锁定节点的相对次序不动；
 * 4. 同一 SCC 内的节点围绕分量中心排成圆，锁定节点保持原坐标；
 * 5. 对全部未锁定节点做去重叠松弛（锁定节点坐标完全不变）。
 */

// 与 .argument-node 的 CSS 尺寸保持一致（含 border）。
const NODE_WIDTH = 214;
const NODE_HEIGHT = 100;
const LAYER_GAP_X = 96;
const SLOT_GAP_Y = 30;
const BARYCENTER_ROUNDS = 4;

export interface LayoutInputNode {
  id: string;
  position: Position;
  layoutLocked: boolean;
}

export interface LayoutInputEdge {
  id: string;
  source: string;
  target: string;
}

export interface LayoutResult {
  /** 每个节点整理后的坐标（锁定节点与输入完全相同） */
  positions: Map<string, Position>;
  /** 整理前的连线交叉数 */
  crossingsBefore: number;
  /** 整理后的连线交叉数 */
  crossingsAfter: number;
  /** 未锁定节点移动的欧氏距离之和 */
  totalDisplacement: number;
  /** 未锁定节点中移动距离最大者 */
  maxDisplacement: number;
}

const finiteOrZero = (value: number): number => (Number.isFinite(value) ? value : 0);

interface LayoutModel {
  nodes: LayoutInputNode[];
  edges: LayoutInputEdge[];
}

function sanitizeModel(nodes: LayoutInputNode[], edges: LayoutInputEdge[]): LayoutModel {
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      layoutLocked: Boolean(node.layoutLocked),
      position: { x: finiteOrZero(node.position.x), y: finiteOrZero(node.position.y) }
    })),
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  };
}

/* ------------------------------------------------------------------ */
/* Tarjan 强连通分量（迭代实现，避免大图递归爆栈）                        */
/* ------------------------------------------------------------------ */

function stronglyConnectedComponents(model: LayoutModel): string[][] {
  const { nodes, edges } = model;
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const adjacency: number[][] = nodes.map(() => []);
  edges.forEach((edge) => {
    const source = indexById.get(edge.source);
    const target = indexById.get(edge.target);
    if (source !== undefined && target !== undefined) adjacency[source].push(target);
  });

  const count = nodes.length;
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  let counter = 0;
  const components: number[][] = [];

  interface Frame {
    vertex: number;
    nextNeighbor: number;
  }

  for (let start = 0; start < count; start += 1) {
    if (index[start] !== -1) continue;
    const callStack: Frame[] = [{ vertex: start, nextNeighbor: 0 }];
    index[start] = counter;
    low[start] = counter;
    counter += 1;
    stack.push(start);
    onStack[start] = 1;

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const neighbors = adjacency[frame.vertex];
      if (frame.nextNeighbor < neighbors.length) {
        const w = neighbors[frame.nextNeighbor];
        frame.nextNeighbor += 1;
        if (index[w] === -1) {
          index[w] = counter;
          low[w] = counter;
          counter += 1;
          stack.push(w);
          onStack[w] = 1;
          callStack.push({ vertex: w, nextNeighbor: 0 });
        } else if (onStack[w]) {
          low[frame.vertex] = Math.min(low[frame.vertex], index[w]);
        }
      } else {
        const v = frame.vertex;
        callStack.pop();
        if (callStack.length > 0) {
          low[callStack[callStack.length - 1].vertex] = Math.min(
            low[callStack[callStack.length - 1].vertex],
            low[v]
          );
        }
        if (low[v] === index[v]) {
          const members: number[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack[w] = 0;
            members.push(w);
            if (w === v) break;
          }
          components.push(members);
        }
      }
    }
  }

  return components.map((members) => members.map((member) => nodes[member].id));
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

interface ComponentModel {
  id: number;
  nodeIds: string[];
  lockedNodeIds: Set<string>;
  /** DAG 层（最长路径） */
  rank: number;
  /** 该分量在层内的排列次序（排序算法维护） */
  order: number;
  /** 分量锚点坐标：含锁定节点时为锁定节点中心，否则为整理后中心 */
  centerX: number;
  centerY: number;
}

export function computeLayout(rawNodes: LayoutInputNode[], rawEdges: LayoutInputEdge[]): LayoutResult {
  const model = sanitizeModel(rawNodes, rawEdges);
  const { nodes, edges } = model;
  const originalPosition = new Map(nodes.map((node) => [node.id, { ...node.position }]));
  const positionsBefore = new Map(nodes.map((node) => [node.id, { ...node.position }]));
  const lockedById = new Map(nodes.map((node) => [node.id, node.layoutLocked]));

  // 1. SCC 压缩。
  const sccs = stronglyConnectedComponents(model);
  const componentByNode = new Map<string, number>();
  sccs.forEach((memberIds, componentId) => {
    memberIds.forEach((id) => componentByNode.set(id, componentId));
  });

  // 分量级 DAG（去重，忽略分量内边与自环）。
  const componentCount = sccs.length;
  const componentEdgesSet = new Set<string>();
  const componentEdges: Array<{ source: number; target: number; nodeEdge: LayoutInputEdge }> = [];
  edges.forEach((edge) => {
    const source = componentByNode.get(edge.source)!;
    const target = componentByNode.get(edge.target)!;
    if (source === target) return;
    const key = source < target ? `${source}>${target}` : `${target}>${source}`;
    if (componentEdgesSet.has(key)) return;
    componentEdgesSet.add(key);
    componentEdges.push({ source, target, nodeEdge: edge });
  });
  const outgoing: number[][] = Array.from({ length: componentCount }, () => []);
  const incoming: number[][] = Array.from({ length: componentCount }, () => []);
  componentEdges.forEach((edge) => {
    outgoing[edge.source].push(edge.target);
    incoming[edge.target].push(edge.source);
  });

  // 2. 最长路径分层：拓扑排序后 rank[c] = max(rank[pred]) + 1。
  const indegree = incoming.map((preds) => preds.length);
  const queue: number[] = [];
  indegree.forEach((degree, id) => {
    if (degree === 0) queue.push(id);
  });
  const topo: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    topo.push(current);
    outgoing[current].forEach((next) => {
      indegree[next] -= 1;
      if (indegree[next] === 0) queue.push(next);
    });
  }
  // SCC 压缩后必然是 DAG；防御性兜底（理论上不会走到）。
  if (topo.length !== componentCount) {
    for (let id = 0; id < componentCount; id += 1) if (!topo.includes(id)) topo.push(id);
  }
  const rank = new Int32Array(componentCount);
  topo.forEach((id) => {
    let best = -1;
    incoming[id].forEach((pred) => {
      best = Math.max(best, rank[pred]);
    });
    rank[id] = best + 1;
  });

  // 3. 建立分量模型与锚点中心。
  const components: ComponentModel[] = sccs.map((nodeIds, id) => {
    const lockedNodeIds = new Set(nodeIds.filter((nodeId) => lockedById.get(nodeId)));
    let centerX = 0;
    let centerY = 0;
    if (lockedNodeIds.size > 0) {
      let sumX = 0;
      let sumY = 0;
      lockedNodeIds.forEach((nodeId) => {
        const position = originalPosition.get(nodeId)!;
        sumX += position.x;
        sumY += position.y;
      });
      centerX = sumX / lockedNodeIds.size;
      centerY = sumY / lockedNodeIds.size;
    } else {
      // 初始中心沿用成员当前位置的均值，纯未锁定图则从 0 开始分层。
      let sumX = 0;
      let sumY = 0;
      nodeIds.forEach((nodeId) => {
        const position = originalPosition.get(nodeId)!;
        sumX += position.x;
        sumY += position.y;
      });
      centerX = sumX / nodeIds.length;
      centerY = sumY / nodeIds.length;
    }
    return { id, nodeIds, lockedNodeIds, rank: rank[id], order: id, centerX, centerY };
  });

  // 4. 每层 x：含锁定节点的层取该层锁定 x 均值；层间线性插值，外侧等距延伸。
  const maxRank = Math.max(0, ...components.map((component) => component.rank));
  const nodesByRank: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  components.forEach((component) => nodesByRank[component.rank].push(component.id));

  const rankX: number[] = new Array(maxRank + 1).fill(0);
  const rankHasLock: boolean[] = new Array(maxRank + 1).fill(false);
  nodesByRank.forEach((memberIds, layer) => {
    const lockedXs: number[] = [];
    memberIds.forEach((componentId) => {
      components[componentId].lockedNodeIds.forEach((nodeId) => {
        lockedXs.push(originalPosition.get(nodeId)!.x);
      });
    });
    if (lockedXs.length > 0) {
      rankHasLock[layer] = true;
      rankX[layer] = lockedXs.reduce((sum, value) => sum + value, 0) / lockedXs.length;
    }
  });
  const columnStep = NODE_WIDTH + LAYER_GAP_X;
  let firstLockedRank = rankHasLock.findIndex(Boolean);
  if (firstLockedRank === -1) {
    // 完全没有锁定：从 0 开始等距分列。
    for (let layer = 0; layer <= maxRank; layer += 1) rankX[layer] = layer * columnStep;
  } else {
    for (let layer = firstLockedRank - 1; layer >= 0; layer -= 1) {
      rankX[layer] = rankX[layer + 1] - columnStep;
    }
    let previousLocked = firstLockedRank;
    for (let layer = firstLockedRank + 1; layer <= maxRank; layer += 1) {
      if (rankHasLock[layer]) {
        const span = layer - previousLocked;
        if (span > 1) {
          const delta = (rankX[layer] - rankX[previousLocked]) / span;
          for (let between = previousLocked + 1; between < layer; between += 1) {
            rankX[between] = rankX[previousLocked] + delta * (between - previousLocked);
          }
        }
        previousLocked = layer;
      }
    }
    for (let layer = previousLocked + 1; layer <= maxRank; layer += 1) {
      rankX[layer] = rankX[layer - 1] + columnStep;
    }
  }

  // 5. 初始层内次序：锁定分量按锚点 y，未锁定分量按中心 y，再用 id 兜底保证确定性。
  nodesByRank.forEach((memberIds) => {
    const sorted = [...memberIds].sort(
      (a, b) =>
        components[a].centerY - components[b].centerY ||
        Number(components[b].lockedNodeIds.size > 0) - Number(components[a].lockedNodeIds.size > 0) ||
        a - b
    );
    sorted.forEach((componentId, order) => {
      components[componentId].order = order;
    });
  });

  // 6. 固定 4 轮重心排序；每轮先正向（按后继重心）再逆向（按前驱重心）。
  // 锁定分量的槽位恒定，只在可移动分量之间重排，再回填到锁定分量之间。
  const barycenter = (componentId: number, neighbors: number[][]) => {
    const values = neighbors[componentId];
    if (values.length === 0) return null;
    let sum = 0;
    values.forEach((neighbor) => {
      sum += components[neighbor].order;
    });
    return sum / values.length;
  };

  const sweep = (layerOrder: number[], neighbors: number[][]) => {
    layerOrder.forEach((layer) => {
      const memberIds = nodesByRank[layer];
      const lockedSlots = new Map<number, number>();
      const movable: number[] = [];
      memberIds.forEach((componentId) => {
        if (components[componentId].lockedNodeIds.size > 0) {
          lockedSlots.set(componentId, components[componentId].order);
        } else {
          movable.push(componentId);
        }
      });
      if (movable.length === 0) return;

      const weights = movable.map((componentId) => ({
        componentId,
        weight: barycenter(componentId, neighbors),
        fallback: components[componentId].centerY,
        previousOrder: components[componentId].order
      }));
      // 稳定排序：权重为空（无邻居）的分量保持上一轮次序；同分次序不动。
      weights.sort((a, b) => {
        if (a.weight === null && b.weight === null) return a.previousOrder - b.previousOrder;
        if (a.weight === null) return 1;
        if (b.weight === null) return -1;
        if (a.weight !== b.weight) return a.weight - b.weight;
        if (a.fallback !== b.fallback) return a.fallback - b.fallback;
        return a.previousOrder - b.previousOrder;
      });

      // 锁定分量的空槽按锚点分成“锁上 / 锁间 / 锁下”几段；
      // 已按重心排好序的可移动分量，放入重心最贴近的空槽段。
      const lockedByOrder = [...lockedSlots.entries()].sort((a, b) => a[1] - b[1]);
      const total = memberIds.length;
      const lockedOrderSet = new Set(lockedByOrder.map(([, order]) => order));
      // 每段是连续的一段空槽下标（第一个锁之前 / 锁之间 / 最后一个锁之后）。
      const segments: number[][] = [];
      let segment: number[] = [];
      for (let order = 0; order < total; order += 1) {
        if (lockedOrderSet.has(order)) {
          if (segment.length > 0) segments.push(segment);
          segment = [];
        } else {
          segment.push(order);
        }
      }
      if (segment.length > 0) segments.push(segment);

      const buckets = segments.map(() => [] as number[]);
      const assignSegment = (weight: number | null, previousOrder: number): number => {
        if (segments.length === 1) return 0;
        let chosen = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        segments.forEach((orders, index) => {
          // 无邻居分量用上一轮槽位选段；其余按重心与空槽段中心的距离选段。
          const target = weight ?? previousOrder;
          const segmentCenter = orders.reduce((sum, order) => sum + order, 0) / orders.length;
          const distance = Math.abs(segmentCenter - target);
          if (distance < bestDistance) {
            bestDistance = distance;
            chosen = index;
          }
        });
        return chosen;
      };
      const overflow: number[] = [];
      weights.forEach((item) => {
        const target = assignSegment(item.weight, item.previousOrder);
        if (buckets[target].length < segments[target].length) buckets[target].push(item.componentId);
        else overflow.push(item.componentId);
      });
      overflow.forEach((componentId) => {
        const target = buckets.findIndex((bucket, index) => bucket.length < segments[index].length);
        buckets[target === -1 ? 0 : target].push(componentId);
      });

      const finalOrder = new Array<number | null>(total).fill(null);
      lockedByOrder.forEach(([componentId, order]) => {
        finalOrder[order] = componentId;
      });
      buckets.forEach((bucket, index) => {
        bucket.forEach((componentId, slot) => {
          const order = segments[index][Math.min(slot, segments[index].length - 1)];
          finalOrder[order] = componentId;
        });
      });
      finalOrder.forEach((componentId, order) => {
        if (componentId !== null) components[componentId].order = order;
      });
    });
  };

  const ascendingRanks = Array.from({ length: maxRank + 1 }, (_, layer) => layer);
  const descendingRanks = [...ascendingRanks].reverse();
  for (let round = 0; round < BARYCENTER_ROUNDS; round += 1) {
    sweep(ascendingRanks, outgoing);
    sweep(descendingRanks, incoming);
  }

  // 7. 层内 y 坐标：锁定分量占据锚点 y；可移动分量在锚点间隙中按槽位铺开。
  const componentExtent = (componentId: number): number => {
    const memberCount = components[componentId].nodeIds.length;
    if (memberCount <= 1) return NODE_HEIGHT;
    // 圆形容量：直径方向至少容纳成员，且与成员节点尺寸匹配。
    const ringCircumference = memberCount * (NODE_HEIGHT + SLOT_GAP_Y);
    const byMembers = ringCircumference / Math.PI;
    return Math.max(NODE_HEIGHT, byMembers) + NODE_HEIGHT;
  };
  const slotStep = (componentIds: number[]) =>
    Math.max(...componentIds.map((componentId) => componentExtent(componentId))) + SLOT_GAP_Y;

  nodesByRank.forEach((memberIds, layer) => {
    const ordered = [...memberIds].sort((a, b) => components[a].order - components[b].order);
    const locked = ordered.filter((componentId) => components[componentId].lockedNodeIds.size > 0);
    const movable = ordered.filter((componentId) => components[componentId].lockedNodeIds.size === 0);

    if (locked.length === 0) {
      // 全未锁定层：以全体锁定 y 的中位（无锁定则 0）为中心等距排列。
      const allLockedY: number[] = [];
      components.forEach((component) => {
        component.lockedNodeIds.forEach((nodeId) => allLockedY.push(originalPosition.get(nodeId)!.y));
      });
      allLockedY.sort((a, b) => a - b);
      const centerY =
        allLockedY.length > 0
          ? allLockedY.length % 2 === 1
            ? allLockedY[(allLockedY.length - 1) / 2]
            : (allLockedY[allLockedY.length / 2 - 1] + allLockedY[allLockedY.length / 2]) / 2
          : 0;
      const step = slotStep(movable);
      const start = centerY - ((movable.length - 1) * step) / 2;
      movable.forEach((componentId, index) => {
        components[componentId].centerY = start + index * step;
      });
      return;
    }

    // 可移动分量按最终次序落到锁定分量之间的空槽组。
    // 结构：top（首个锁定之上）、between（每两个锁定之间）、bottom（最后锁定之下）。
    const lockedYs = locked.map((componentId) => components[componentId].centerY);
    const groups: number[][] = Array.from({ length: locked.length + 1 }, () => []);
    let groupCursor = 0;
    ordered.forEach((componentId) => {
      if (components[componentId].lockedNodeIds.size > 0) {
        groupCursor += 1;
      } else {
        groups[Math.min(groupCursor, groups.length - 1)].push(componentId);
      }
    });

    // 顶端组：从第一个锁定分量向上等距铺开。
    const topGroup = groups[0];
    if (topGroup.length > 0) {
      const step = slotStep(topGroup);
      const base = lockedYs[0] - componentExtent(locked[0]) / 2 - SLOT_GAP_Y - topGroup.length * step + step / 2;
      topGroup.forEach((componentId, index) => {
        components[componentId].centerY = base + index * step;
      });
    }
    // 中间各组：在相邻两个锁定分量的间隙内居中铺开。
    for (let lockedIndex = 0; lockedIndex < locked.length - 1; lockedIndex += 1) {
      const group = groups[lockedIndex + 1];
      const upper = lockedYs[lockedIndex] + componentExtent(locked[lockedIndex]) / 2 + SLOT_GAP_Y;
      const lower = lockedYs[lockedIndex + 1] - componentExtent(locked[lockedIndex + 1]) / 2 - SLOT_GAP_Y;
      placeGroupInGap(group, upper, lower, slotStep(group));
    }
    // 底端组：从最后一个锁定分量向下等距铺开。
    const bottomGroup = groups[groups.length - 1];
    if (bottomGroup.length > 0) {
      const step = slotStep(bottomGroup);
      const base =
        lockedYs[lockedYs.length - 1] + componentExtent(locked[locked.length - 1]) / 2 + SLOT_GAP_Y + step / 2;
      bottomGroup.forEach((componentId, index) => {
        components[componentId].centerY = base + index * step;
      });
    }
  });

  /** 在两个锁定分量的纵向间隙内居中铺开一组可移动分量；放不下时以步长溢出（交给后续去重叠修正）。 */
  function placeGroupInGap(group: number[], upper: number, lower: number, step: number) {
    if (group.length === 0) return;
    const required = (group.length - 1) * step;
    const available = lower - upper;
    const start = required <= available ? upper + (available - required) / 2 : upper;
    group.forEach((componentId, index) => {
      components[componentId].centerY = start + index * step;
    });
  }

  // 8. 分量 x：含锁定节点的分量锚点不动；其余分量取本层列中心。
  components.forEach((component) => {
    if (component.lockedNodeIds.size === 0) {
      component.centerX = rankX[component.rank];
    }
  });

  // 9. 生成节点坐标：锁定节点保持原位；SCC 内其余节点绕中心排圆；单点未锁定分量直接取分量中心。
  const nextPositions = new Map<string, Position>();
  components.forEach((component) => {
    if (component.nodeIds.length === 1) {
      const nodeId = component.nodeIds[0];
      if (component.lockedNodeIds.has(nodeId)) {
        const position = originalPosition.get(nodeId)!;
        nextPositions.set(nodeId, { x: position.x, y: position.y });
      } else {
        nextPositions.set(nodeId, { x: component.centerX - NODE_WIDTH / 2, y: component.centerY - NODE_HEIGHT / 2 });
      }
      return;
    }

    const movableNodeIds = component.nodeIds.filter((nodeId) => !component.lockedNodeIds.has(nodeId));
    // 圆半径：保证圆周上相邻节点不重叠，且距锁定节点（视为半径 0 的内部障碍）留有间隙。
    const radius =
      Math.max(
        NODE_HEIGHT,
        (movableNodeIds.length * (NODE_HEIGHT + SLOT_GAP_Y)) / (2 * Math.PI),
        component.lockedNodeIds.size > 0
          ? Math.sqrt((210 * 210) / 4) + NODE_HEIGHT / 2 + SLOT_GAP_Y
          : 0
      ) + (component.lockedNodeIds.size > 0 ? NODE_HEIGHT / 2 : 0);

    // 锁定节点固定，保持原坐标作为圆周内部的锚点障碍。
    component.lockedNodeIds.forEach((nodeId) => {
      const position = originalPosition.get(nodeId)!;
      nextPositions.set(nodeId, { x: position.x, y: position.y });
    });

    // 未锁定节点的目标角：均匀角栅格上选择与原方向最接近的旋转，使总位移最小。
    const movableCount = movableNodeIds.length;
    const desiredAngles = movableNodeIds.map((nodeId) => {
      const position = originalPosition.get(nodeId)!;
      return Math.atan2(position.y - component.centerY, position.x - component.centerX);
    });
    const baseAngles = movableNodeIds.map((_, index) => (2 * Math.PI * index) / movableCount);
    let bestRotation = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < movableCount; candidate += 1) {
      const rotation = (2 * Math.PI * candidate) / movableCount;
      let cost = 0;
      movableNodeIds.forEach((_, index) => {
        let delta = Math.abs(baseAngles[index] + rotation - desiredAngles[index]) % (2 * Math.PI);
        if (delta > Math.PI) delta = 2 * Math.PI - delta;
        cost += delta;
      });
      if (cost < bestCost) {
        bestCost = cost;
        bestRotation = rotation;
      }
    }

    movableNodeIds.forEach((nodeId, index) => {
      const angle = baseAngles[index] + bestRotation - Math.PI / 2;
      nextPositions.set(nodeId, {
        x: component.centerX + radius * Math.cos(angle) - NODE_WIDTH / 2,
        y: component.centerY + radius * Math.sin(angle) - NODE_HEIGHT / 2
      });
    });
  });

  // 10. 去重叠：锁定节点不动；未锁定节点不得与任何节点重叠（含锁定节点）。
  resolveOverlaps(nextPositions, lockedById);

  // 11. 有限数兜底：理论上所有坐标都有限，这里做最终断言式修正。
  nextPositions.forEach((position, nodeId) => {
    const safe = {
      x: Number.isFinite(position.x) ? position.x : finiteOrZero(originalPosition.get(nodeId)!.x),
      y: Number.isFinite(position.y) ? position.y : finiteOrZero(originalPosition.get(nodeId)!.y)
    };
    nextPositions.set(nodeId, safe);
  });

  // 锁定节点坐标必须完全不变。
  nodes.forEach((node) => {
    if (node.layoutLocked) {
      const original = originalPosition.get(node.id)!;
      nextPositions.set(node.id, { x: original.x, y: original.y });
    }
  });

  const crossingsBefore = countCrossings(model, positionsBefore);
  const crossingsAfter = countCrossings(model, nextPositions);

  let totalDisplacement = 0;
  let maxDisplacement = 0;
  nodes.forEach((node) => {
    if (node.layoutLocked) return;
    const before = originalPosition.get(node.id)!;
    const after = nextPositions.get(node.id)!;
    const distance = Math.hypot(after.x - before.x, after.y - before.y);
    totalDisplacement += distance;
    maxDisplacement = Math.max(maxDisplacement, distance);
  });

  return {
    positions: nextPositions,
    crossingsBefore,
    crossingsAfter,
    totalDisplacement,
    maxDisplacement
  };
}

/* ------------------------------------------------------------------ */
/* 去重叠                                                               */
/* ------------------------------------------------------------------ */

interface Box {
  x: number;
  y: number;
}

// 节点矩形外扩 overlapGap 作为碰撞盒：解决后相邻节点至少留有间隙。
const overlapGap = 8;
const collisionW = NODE_WIDTH + overlapGap;
const collisionH = NODE_HEIGHT + overlapGap;

function boxesOverlap(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < collisionW && Math.abs(a.y - b.y) < collisionH;
}

function resolveOverlaps(positions: Map<string, Position>, lockedById: Map<string, boolean>) {
  const ids = [...positions.keys()];
  const movableIds = ids.filter((id) => !lockedById.get(id));
  if (movableIds.length === 0) return;
  const centerOf = (id: string): Box => {
    const position = positions.get(id)!;
    return { x: position.x + NODE_WIDTH / 2, y: position.y + NODE_HEIGHT / 2 };
  };

  // 迭代推离：每轮扫描所有“未锁定 × 任意”冲突，沿中心连线把未锁定者推出碰撞盒。
  const iterations = Math.min(40, 8 + Math.floor(movableIds.length / 4));
  for (let pass = 0; pass < iterations; pass += 1) {
    let moved = false;
    for (let i = 0; i < ids.length; i += 1) {
      const a = ids[i];
      const centerA = centerOf(a);
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = ids[j];
        const aLocked = lockedById.get(a);
        const bLocked = lockedById.get(b);
        if (aLocked && bLocked) continue; // 两个锁定节点允许重叠。
        const centerB = centerOf(b);
        const overlapX = collisionW - Math.abs(centerA.x - centerB.x);
        const overlapY = collisionH - Math.abs(centerA.y - centerB.y);
        if (overlapX <= 0 || overlapY <= 0) continue;

        let pushId: string;
        let other: Box;
        if (!aLocked && !bLocked) {
          // 两个未锁定：推动外层循环索引更大的那个，保证确定性。
          pushId = b;
          other = centerA;
        } else if (aLocked) {
          pushId = b;
          other = centerA;
        } else {
          pushId = a;
          other = centerB;
        }
        const center = centerOf(pushId);
        let dx = center.x - other.x;
        let dy = center.y - other.y;
        const distance = Math.hypot(dx, dy);
        const push = Math.min(overlapX, overlapY) + 1;
        if (distance < 0.001) {
          // 完全重合时沿 y 轴向上推，避免零向量。
          dx = 0;
          dy = 1;
        } else {
          dx /= distance;
          dy /= distance;
        }
        const position = positions.get(pushId)!;
        position.x += dx * push;
        position.y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // 兜底：仍有冲突的未锁定节点做螺旋搜索，找最近的合法空位。
  const findFree = (id: string): Position | null => {
    const current = positions.get(id)!;
    const center = { x: current.x + NODE_WIDTH / 2, y: current.y + NODE_HEIGHT / 2 };
    for (let ring = 1; ring <= 240; ring += 1) {
      const candidates: Array<[number, number]> = [
        [center.x, center.y - ring * 6],
        [center.x + ring * 6, center.y],
        [center.x, center.y + ring * 6],
        [center.x - ring * 6, center.y],
        [center.x + ring * 4, center.y - ring * 4],
        [center.x + ring * 4, center.y + ring * 4],
        [center.x - ring * 4, center.y + ring * 4],
        [center.x - ring * 4, center.y - ring * 4]
      ];
      for (const [x, y] of candidates) {
        let free = true;
        for (const otherId of ids) {
          if (otherId === id) continue;
          const otherPosition = positions.get(otherId)!;
          const other = { x: otherPosition.x + NODE_WIDTH / 2, y: otherPosition.y + NODE_HEIGHT / 2 };
          if (boxesOverlap({ x, y }, other)) {
            free = false;
            break;
          }
        }
        if (free) return { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 };
      }
    }
    return null;
  };

  movableIds.forEach((id) => {
    const center = centerOf(id);
    for (const otherId of ids) {
      if (otherId === id) continue;
      const otherPosition = positions.get(otherId)!;
      const other = { x: otherPosition.x + NODE_WIDTH / 2, y: otherPosition.y + NODE_HEIGHT / 2 };
      if (boxesOverlap(center, other)) {
        const freePosition = findFree(id);
        if (freePosition) positions.set(id, freePosition);
        break;
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 交叉数                                                               */
/* ------------------------------------------------------------------ */

/** 有向边取节点左/右连接点：源右侧 (x+w, y+h/2)，目标左侧 (x, y+h/2)。 */
function edgeEndpoints(edge: LayoutInputEdge, positions: Map<string, Position>) {
  const source = positions.get(edge.source);
  const target = positions.get(edge.target);
  if (!source || !target) return null;
  return {
    ax: source.x + NODE_WIDTH,
    ay: source.y + NODE_HEIGHT / 2,
    bx: target.x,
    by: target.y + NODE_HEIGHT / 2
  };
}

function segmentsCross(
  p: { ax: number; ay: number; bx: number; by: number },
  q: { ax: number; ay: number; bx: number; by: number }
): boolean {
  const orientation = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ): number => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const o1 = orientation(p.ax, p.ay, p.bx, p.by, q.ax, q.ay);
  const o2 = orientation(p.ax, p.ay, p.bx, p.by, q.bx, q.by);
  const o3 = orientation(q.ax, q.ay, q.bx, q.by, p.ax, p.ay);
  const o4 = orientation(q.ax, q.ay, q.bx, q.by, p.bx, p.by);
  const epsilon = 1e-7;
  const strict = (a: number, b: number) => (a > epsilon && b < -epsilon) || (a < -epsilon && b > epsilon);
  return strict(o1, o2) && strict(o3, o4);
}

function countCrossings(model: LayoutModel, positions: Map<string, Position>): number {
  const segments = model.edges
    .filter((edge) => edge.source !== edge.target)
    .map((edge) => edgeEndpoints(edge, positions))
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null);
  let count = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const a = segments[i];
      const b = segments[j];
      // 共端点不算交叉；包围盒不相交不可能交叉。
      if (
        Math.max(a.ax, a.bx) < Math.min(b.ax, b.bx) ||
        Math.min(a.ax, a.bx) > Math.max(b.ax, b.bx) ||
        Math.max(a.ay, a.by) < Math.min(b.ay, b.by) ||
        Math.min(a.ay, a.by) > Math.max(b.ay, b.by)
      ) {
        continue;
      }
      if (segmentsCross(a, b)) count += 1;
    }
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* 预览失效指纹                                                          */
/* ------------------------------------------------------------------ */

/**
 * 预览只对生成时的图有效：任何图编辑（拓扑、标签不影响布局但仍纳入、锁定集合、坐标）
 * 都会改变指纹。坐标纳入是因为用户拖动画布后预览坐标已过期。
 */
export function layoutFingerprint(graph: GraphDocument): string {
  const nodes = graph.nodes
    .map((node) => `${node.id}:${node.layoutLocked ? 1 : 0}:${Math.round(node.position.x)}:${Math.round(node.position.y)}`)
    .sort()
    .join('|');
  // 边的任何属性（source/target/stance/weight）变化都属于图编辑，都要使预览失效。
  const edges = graph.edges
    .map((edge) => `${edge.source}>${edge.target}:${edge.stance}:${edge.weight}`)
    .sort()
    .join('|');
  return `${nodes}__${edges}`;
}
