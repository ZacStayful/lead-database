/**
 * Presentation for a lead assignment status. Colours follow the product spec:
 *   new → blue · contacted → amber · in_discussion → purple · won → green
 *   not_relevant → grey · rejected → grey, italic
 */
export interface StatusBadge {
  label: string;
  className: string;
}

const MAP: Record<string, StatusBadge> = {
  new: {
    label: "New",
    className: "border-transparent bg-blue-100 text-blue-700",
  },
  contacted: {
    label: "Contacted",
    className: "border-transparent bg-amber-100 text-amber-700",
  },
  in_discussion: {
    label: "In discussion",
    className: "border-transparent bg-purple-100 text-purple-700",
  },
  won: {
    label: "Won",
    className: "border-transparent bg-green-100 text-green-700",
  },
  not_relevant: {
    label: "Not relevant",
    className: "border-transparent bg-gray-100 text-gray-600",
  },
  rejected: {
    label: "Rejected",
    className: "border-transparent bg-gray-100 text-gray-500 italic",
  },
};

export function statusBadge(status: string): StatusBadge {
  return (
    MAP[status] ?? {
      label: status,
      className: "border-transparent bg-gray-100 text-gray-600",
    }
  );
}
