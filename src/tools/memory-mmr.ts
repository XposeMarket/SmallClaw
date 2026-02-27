export interface MMRItem {
  id: string;
  score: number;
  content: string;
}

export interface MMROptions {
  enabled?: boolean;
  lambda?: number;
  max?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? (intersection / union) : 0;
}

export function mmrRerank(items: MMRItem[], opts: MMROptions = {}): MMRItem[] {
  if (!Array.isArray(items) || items.length <= 1) return Array.isArray(items) ? items : [];
  if (opts.enabled === false) return items.slice();

  const lambda = clamp(typeof opts.lambda === 'number' ? opts.lambda : 0.7, 0, 1);
  const max = Math.max(1, Math.min(Math.floor(opts.max ?? items.length), items.length));
  const maxScore = Math.max(1e-9, ...items.map((i) => Number.isFinite(i.score) ? i.score : 0));

  const pool = items.map((item) => ({
    item,
    tokens: tokenize(item.content),
    rel: clamp((Number.isFinite(item.score) ? item.score : 0) / maxScore, 0, 1),
  }));

  const chosen: typeof pool = [];
  while (chosen.length < max && pool.length > 0) {
    let bestIdx = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      let maxSim = 0;
      for (const picked of chosen) {
        const sim = jaccard(candidate.tokens, picked.tokens);
        if (sim > maxSim) maxSim = sim;
      }
      const mmrValue = (lambda * candidate.rel) - ((1 - lambda) * maxSim);
      if (mmrValue > bestValue) {
        bestValue = mmrValue;
        bestIdx = i;
      }
    }

    const [next] = pool.splice(bestIdx, 1);
    if (next) chosen.push(next);
  }

  return chosen.map((x) => x.item);
}

