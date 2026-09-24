"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import {
  TENURE_BANDS,
  type MrrPoint,
  type Milestone,
  type TenureBandKey,
} from "@/lib/retention";

/**
 * Daily MRR in force, banded by tenure.
 *
 * WHY FIVE LINES AND NOT A STACKED AREA
 * -------------------------------------
 * Trend-over-time with several series is a line chart. A stacked area makes any
 * middle band unreadable — you would be measuring the 3–6 band by eye against a
 * moving floor — and the total is already a stat tile above the chart.
 *
 * ⚠️ ONE Y-AXIS, ALWAYS. The obvious next request is to put the stable-share
 * percentage on a right-hand axis. Never do that: two y-scales on one chart is
 * the single most misleading thing a chart can do, because the crossing point of
 * the two lines is an artefact of the scales rather than a fact. The share is a
 * stat tile.
 *
 * COLOUR: AN ORDINAL RAMP, NOT FIVE CATEGORICAL HUES
 * --------------------------------------------------
 * Swapping the band order would change the meaning — these are age buckets — so
 * this is ordinal data, and ordinal data takes ONE hue with monotone lightness
 * steps, so the reader sees the order in the colour itself. Five distinct hues
 * would spend the identity channel re-encoding something the labels already say,
 * and would leave no visual cue that 12mo+ is "more" than 0–1mo.
 *
 * The ramp was validated rather than eyeballed — one hue (3° spread), monotone
 * lightness, every adjacent step ≥ 0.06 apart in L, and every step clearing
 * 2:1 against the page surface (#fcfcfb): 2.07, 3.14, 4.99, 8.60, 13.56:1.
 *
 * ⚠️ The lightest step sits at 2.07:1, which obligates a relief channel — the
 * banded £ tiles and the retention table on the same page are it, and must ship
 * with the chart rather than after it. Do not remove them and leave the chart.
 *
 * ⚠️ A DARK RAMP IS DELIBERATELY NOT WIRED UP. tailwind.config.ts sets
 * darkMode: ["class"] but globals.css defines no dark token block and only four
 * files in src/ use a `dark:` variant — the app is light-only in practice. A
 * dark ramp here could only fire on a page that stayed white, which is worse
 * than not having one. The validated steps, for the day dark mode lands, are
 * (0–1mo → 12mo+, anchor FLIPPED so lighter means more stable, each ≥ 2:1 on
 * #1a1a19): #3d5a37, #4f7346, #6b9160, #8fb384, #b8d3ae. A straight inversion
 * of the light ramp would sink the stable band into the background.
 */
const BAND_COLOUR: Record<TenureBandKey, string> = {
  m0_1: "#9cba93",
  m1_3: "#74996b",
  m3_6: "#52774b",
  m6_12: "#365132",
  m12_plus: "#1e3119",
};

const AXIS_INK = "#898781";
const GRID = "rgba(0,0,0,.05)";
const MILESTONE = "#c26b3d";

function poundsLabel(pence: number): string {
  if (pence === 0) return "£0";
  if (pence >= 100_000) return `£${Math.round(pence / 100_000)}k`;
  return `£${Math.round(pence / 100)}`;
}

function exactPounds(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(pence / 100);
}

function dayLabel(ymd: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  }).format(new Date(`${ymd}T12:00:00Z`));
}

interface TooltipProps {
  active?: boolean;
  payload?: { payload: MrrPoint }[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-black/10 bg-white px-3 py-2 text-xs shadow-sm">
      <div className="mb-1.5 font-semibold text-[#1a1a19]">
        {label ? dayLabel(label) : ""}
      </div>
      {/* Newest band last, so the rows read in the same order as the ramp. */}
      {TENURE_BANDS.map((band) => (
        <div key={band.key} className="flex items-center gap-2 tabular-nums">
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: BAND_COLOUR[band.key] }}
          />
          <span className="text-[#55564f]">{band.shortLabel}</span>
          <span className="ml-auto font-medium text-[#1a1a19]">
            {exactPounds(point[band.key])}
          </span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center gap-2 border-t border-black/10 pt-1.5 tabular-nums">
        <span className="text-[#55564f]">
          Total · {point.customers} subscription{point.customers === 1 ? "" : "s"}
        </span>
        <span className="ml-auto font-semibold text-[#1a1a19]">
          {exactPounds(point.totalPence)}
        </span>
      </div>
    </div>
  );
}

export interface RetentionChartProps {
  series: MrrPoint[];
  milestones: Milestone[];
}

export function RetentionChart({ series, milestones }: RetentionChartProps) {
  if (series.length === 0) {
    return (
      <p className="p-5 text-sm text-muted-foreground">
        Nothing to plot yet — no subscription invoice has been paid.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={series} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={dayLabel}
          tick={{ fontSize: 11, fill: AXIS_INK }}
          tickLine={false}
          axisLine={false}
          minTickGap={36}
        />
        <YAxis
          tickFormatter={poundsLabel}
          tick={{ fontSize: 11, fill: AXIS_INK }}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: AXIS_INK, strokeDasharray: "3 3" }} />
        <Legend
          verticalAlign="bottom"
          height={28}
          iconType="plainline"
          wrapperStyle={{ fontSize: 11, color: AXIS_INK }}
        />
        {milestones.map((milestone) => (
          <ReferenceLine
            key={milestone.date}
            x={milestone.date}
            stroke={MILESTONE}
            strokeDasharray="4 4"
            label={{
              value: milestone.label,
              position: "insideTopRight",
              fontSize: 10,
              fill: MILESTONE,
            }}
          />
        ))}
        {TENURE_BANDS.map((band) => (
          <Line
            key={band.key}
            type="monotone"
            dataKey={band.key}
            name={band.shortLabel}
            stroke={BAND_COLOUR[band.key]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: BAND_COLOUR[band.key] }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
