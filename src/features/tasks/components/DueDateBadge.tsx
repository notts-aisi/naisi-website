import Badge from "@/components/ui/Badge";

type Props = { dueDate: Date | null; done?: boolean };

function formatShort(date: Date): string {
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

function relative(date: Date, now: Date): string {
  const diffMs = date.getTime() - now.getTime();
  const absHrs = Math.abs(diffMs) / (1000 * 60 * 60);
  if (absHrs < 24) {
    const hours = Math.round(diffMs / (1000 * 60 * 60));
    if (hours === 0) return "now";
    return hours > 0 ? `in ${hours}h` : `${-hours}h late`;
  }
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (days > 0) return `in ${days}d`;
  return `${-days}d late`;
}

export default function DueDateBadge({ dueDate, done }: Props) {
  if (!dueDate) return null;
  const now = new Date();
  const overdue = !done && dueDate.getTime() < now.getTime();
  const dueSoon = !done && !overdue && dueDate.getTime() - now.getTime() < 48 * 60 * 60 * 1000;

  const tone = done ? "neutral" : overdue ? "danger" : dueSoon ? "warning" : "neutral";
  const label = done ? formatShort(dueDate) : `${formatShort(dueDate)} · ${relative(dueDate, now)}`;

  return (
    <Badge tone={tone} aria-label={`Due ${formatShort(dueDate)}`}>
      {label}
    </Badge>
  );
}
