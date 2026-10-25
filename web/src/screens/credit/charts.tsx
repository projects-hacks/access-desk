/** Small inline-SVG charts for the credit screens. */

export const TIER_COLORS: Record<number, string> = {
  1: '#0a0b0d',
  2: '#0052ff',
  3: '#8a919e',
  4: '#c2410c',
  5: '#cf202f',
};

export function Sparkline({
  values,
  width = 72,
  height = 22,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 100);
  const pts = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * width},${height - ((v - lo) / (hi - lo || 1)) * height}`,
    )
    .join(' ');
  const up = values.at(-1)! >= values[0]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke={up ? 'var(--good)' : 'var(--bad)'}
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function Meter({ value, tone }: { value: number; tone?: 'good' | 'warn' | 'bad' }) {
  const t = tone ?? (value >= 70 ? 'good' : value >= 45 ? 'warn' : 'bad');
  return (
    <span className={`meter ${t}`}>
      <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </span>
  );
}

export type Dot = { id: string; x: number; y: number; tier: number; label: string };

/** Value (x) against reliability (y), 0–100 each; dots coloured by tier. */
export function Scatter({
  dots,
  selected,
  onSelect,
}: {
  dots: Dot[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const W = 560;
  const H = 300;
  const pad = { l: 34, r: 12, t: 12, b: 28 };
  const x = (v: number) => pad.l + (v / 100) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / 100) * (H - pad.t - pad.b);
  return (
    <svg
      className="scatter"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Value against reliability, one dot per client"
    >
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={x(g)} x2={x(g)} y1={y(0)} y2={y(100)} className="grid" />
          <line x1={x(0)} x2={x(100)} y1={y(g)} y2={y(g)} className="grid" />
        </g>
      ))}
      <text x={x(50)} y={H - 6} className="axis" textAnchor="middle">
        Value score →
      </text>
      <text
        x={10}
        y={y(50)}
        className="axis"
        textAnchor="middle"
        transform={`rotate(-90 10 ${y(50)})`}
      >
        Reliability →
      </text>
      <text x={x(100) - 4} y={y(100) + 12} className="quad" textAnchor="end">
        Protect
      </text>
      <text x={x(0) + 4} y={y(0) - 6} className="quad">
        Prepay sooner
      </text>
      {dots.map((d) => (
        <circle
          key={d.id}
          cx={x(d.x)}
          cy={y(d.y)}
          r={d.id === selected ? 7 : 5}
          fill={TIER_COLORS[d.tier] ?? '#8a919e'}
          className={d.id === selected ? 'dot selected' : 'dot'}
          onClick={() => onSelect(d.id)}
        >
          <title>
            {d.label} · value {d.x} · reliability {d.y} · T{d.tier}
          </title>
        </circle>
      ))}
    </svg>
  );
}

/** Score histogram in bins of 5, bars coloured by the tier each bin falls in. */
export function Histogram({
  scores,
  tierOf,
}: {
  scores: number[];
  tierOf: (score: number) => number;
}) {
  const bins = Array.from({ length: 20 }, (_, i) => i * 5);
  const counts = bins.map(
    (b) => scores.filter((s) => s >= b && (b === 95 ? s <= 100 : s < b + 5)).length,
  );
  const max = Math.max(1, ...counts);
  const W = 560;
  const H = 150;
  const bw = W / bins.length;
  return (
    <svg
      className="histogram"
      viewBox={`0 0 ${W} ${H + 18}`}
      role="img"
      aria-label="How many clients at each score"
    >
      {bins.map((b, i) => {
        const h = (counts[i]! / max) * (H - 4);
        return (
          <rect
            key={b}
            x={i * bw + 1}
            y={H - h}
            width={bw - 2}
            height={h}
            rx="2"
            fill={TIER_COLORS[tierOf(b + 2.5)] ?? '#8a919e'}
          >
            <title>
              Score {b}–{b + 4}: {counts[i]} clients
            </title>
          </rect>
        );
      })}
      <text x="0" y={H + 14} className="axis">
        Score 0
      </text>
      <text x={W / 2} y={H + 14} className="axis" textAnchor="middle">
        50
      </text>
      <text x={W} y={H + 14} className="axis" textAnchor="end">
        100
      </text>
    </svg>
  );
}
