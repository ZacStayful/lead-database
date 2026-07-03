"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

interface Point {
  month: string;
  revenue: number;
}

// Monthly recurring revenue added by marketplace-sourced properties — roughly
// one new property every two months from month three.
const REVENUE = [
  0, 0, 0, 289, 289, 578, 578, 867, 867, 867, 1156, 1156, 1445, 1445, 1445,
  1734, 1734, 2023, 2023, 2312, 2312, 2601, 2890, 3179,
];

const data: Point[] = REVENUE.map((revenue, i) => ({
  month: `M${i + 1}`,
  revenue,
}));

interface TooltipProps {
  active?: boolean;
  payload?: { payload: Point }[];
}

function CustomTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-black/10 bg-white px-3 py-2 text-xs">
      <div className="mb-1 font-semibold text-[#1a1a19]">{p.month}</div>
      <div className="text-[#3B6D11]">
        Marketplace MRR: £{p.revenue.toLocaleString()}/mo
      </div>
    </div>
  );
}

export function RevenueChart() {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="rgba(0,0,0,.04)" vertical={false} />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 10, fill: "#898781" }}
          tickLine={false}
          axisLine={false}
          interval={1}
        />
        <YAxis
          tickFormatter={(v) => `£${v}`}
          tick={{ fontSize: 11, fill: "#898781" }}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(93,129,86,.06)" }} />
        <ReferenceLine
          y={300}
          stroke="#3B6D11"
          strokeDasharray="5 4"
          strokeWidth={1.5}
          label={{
            value: "£300 subscription",
            position: "insideTopRight",
            fontSize: 11,
            fill: "#3B6D11",
          }}
        />
        <Bar
          dataKey="revenue"
          fill="#5D8156"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
