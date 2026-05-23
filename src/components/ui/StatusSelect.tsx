"use client";

import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import { STATUS_LABELS, type AffiliationStatus } from "@/lib/firestore/users";

type Props = {
  id: string;
  value: AffiliationStatus | "";
  onChange: (next: AffiliationStatus | "") => void;
  required?: boolean;
};

const ORDER: AffiliationStatus[] = [
  "foundation",
  "undergraduate",
  "masters",
  "phd",
  "postdoc",
  "employee",
  "other",
];

export default function StatusSelect({ value, onChange }: Props) {
  const options: ResponsiveSelectOption<AffiliationStatus | "">[] = [
    { value: "", label: "Select your status" },
    ...ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
  ];
  return (
    <ResponsiveSelect<AffiliationStatus | "">
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel="Status"
    />
  );
}
