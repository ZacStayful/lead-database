"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

interface Point {
  month: number;
  properties: number;
  revenue: number;
}

// Properties added: 0 for months 1–2, then one new property every two months.
const data: Point[] = Array.from({ length: 24 }, (_, i) => {
  const month = i + 1;
  const properties = month <= 2 ? 0 : Math.floor((month - 2) / 2);
  return { month, properties, revenue: properties * 289 };
});

const DOT_MONTHS = new Set([3, 6, 12, 18, 24]);

interface DotProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: Point;
}

function renderDot({ cx, cy, index, payload }: DotProps) {
  const key = `dot-${index}`;
  if (!payload || cx == null || cy == null || !DOT_MONTHS.has(payload.month)) {
    return <g key={key} />;
  }
  return (
    <circle
      key={key}
      cx={cx}
      cy={cy}
      r={4}
      fill="#3B6D11"
      stroke="#ffffff"
      strokeWidth={1.5}
    />
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: { payload: Point }[];
}

function CustomTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-black/10 bg-white px-3 py-2 text-xs">
      <div className="font-medium text-[#1a1a19]">Month {p.month}</div>
      <div className="text-[#52514e]">Properties: {p.properties}</div>
      <div className="text-[#3B6D11]">Revenue: £{p.revenue.toLocaleString()}/mo</div>
    </div>
  );
}

export function CompoundingChart() {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 16, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(11,11,11,0.06)" />
        <XAxis
          dataKey="month"
          type="number"
          domain={[1, 24]}
          ticks={[1, 3, 6, 12, 18, 24]}
          tickFormatter={(v) => `M${v}`}
          tick={{ fontSize: 11, fill: "#898781" }}
          tickLine={false}
          axisLine={{ stroke: "rgba(11,11,11,0.10)" }}
        />
        <YAxis
          tickFormatter={(v) => `£${v}`}
          tick={{ fontSize: 11, fill: "#898781" }}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine
          y={300}
          stroke="#898781"
          strokeDasharray="5 4"
          label={{
            value: "£300/mo subscription",
            position: "insideTopLeft",
            fontSize: 11,
            fill: "#898781",
          }}
        />
        <Line
          type="stepAfter"
          dataKey="revenue"
          stroke="#3B6D11"
          strokeWidth={2}
          dot={renderDot}
          activeDot={{ r: 5, fill: "#3B6D11" }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
