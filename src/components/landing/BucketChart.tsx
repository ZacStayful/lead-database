"use client";

import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Point {
  label: string;
  withM: number;
  without: number;
}

// A 25-property portfolio over 24 months, same 10–12% churn — the only
// difference is a steady supply of new leads.
const data: Point[] = [
  { label: "M0", withM: 25, without: 25 },
  { label: "M3", withM: 25.3, without: 24.6 },
  { label: "M6", withM: 25.9, without: 24.1 },
  { label: "M9", withM: 26.7, without: 23.5 },
  { label: "M12", withM: 27.6, without: 22.9 },
  { label: "M15", withM: 28.4, without: 22.4 },
  { label: "M18", withM: 29.1, without: 21.9 },
  { label: "M21", withM: 29.7, without: 21.4 },
  { label: "M24", withM: 30.2, without: 21.0 },
];

interface TooltipProps {
  active?: boolean;
  payload?: { payload: Point }[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-black/10 bg-white px-3 py-2 text-xs">
      <div className="mb-1 font-semibold text-[#1a1a19]">{label}</div>
      <div className="text-[#3B6D11]">
        With the marketplace: {Math.round(p.withM)} properties
      </div>
      <div className="text-[#898781]">
        Without: {Math.round(p.without)} properties
      </div>
    </div>
  );
}

export function BucketChart() {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <defs>
          <linearGradient id="sfBucketGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5D8156" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#5D8156" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(0,0,0,.05)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "#898781" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          domain={[18, 32]}
          ticks={[18, 22, 26, 30]}
          tick={{ fontSize: 11, fill: "#898781" }}
          tickLine={false}
          axisLine={false}
          width={28}
        />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone"
          dataKey="without"
          stroke="#898781"
          strokeWidth={2}
          strokeDasharray="6 5"
          fill="transparent"
          dot={false}
          activeDot={{ r: 5, fill: "#898781" }}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="withM"
          stroke="#5D8156"
          strokeWidth={3}
          fill="url(#sfBucketGrad)"
          dot={false}
          activeDot={{ r: 5, fill: "#3B6D11" }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
