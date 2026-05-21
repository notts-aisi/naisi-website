import { Section, Text } from "@react-email/components";
import type { EventChange } from "@/lib/events/changeSummary";

/**
 * Shared email block that renders a set of event changes as struck-through
 * old, clear new, e.g. "When: Fri 6 Jun, 18:00 → Sat 7 Jun, 18:00". Embedded
 * in the broadcast and acceptance emails; renders nothing for an empty diff.
 */
export default function EventChangeSummary({
  changes,
}: {
  changes: EventChange[];
}) {
  if (changes.length === 0) return null;
  return (
    <Section style={box}>
      {changes.map((c) => (
        <Text key={c.label} style={row}>
          <strong style={labelStyle}>{c.label}: </strong>
          <span style={oldStyle}>{c.from}</span>
          <span style={arrowStyle}> → </span>
          <span style={newStyle}>{c.to}</span>
        </Text>
      ))}
    </Section>
  );
}

const box: React.CSSProperties = {
  backgroundColor: "#fdf6ec",
  border: "1px solid #f0e0c8",
  borderRadius: "8px",
  padding: "12px 16px",
  margin: "16px 0",
};

const row: React.CSSProperties = {
  fontSize: "15px",
  lineHeight: 1.6,
  color: "#27272a",
  margin: "6px 0",
};

const labelStyle: React.CSSProperties = {
  color: "#09090b",
};

const oldStyle: React.CSSProperties = {
  textDecoration: "line-through",
  color: "#a1a1aa",
};

const arrowStyle: React.CSSProperties = {
  color: "#a1a1aa",
};

const newStyle: React.CSSProperties = {
  fontWeight: 700,
  color: "#09090b",
};
