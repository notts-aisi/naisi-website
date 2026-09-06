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

// BOTH `id` AND `required` REACH THE CONTROL. Every caller wraps this in a
// `<Field id="…">`, whose label is an explicit `htmlFor` rather than a wrapper,
// so an id that stopped here left the label pointing at nothing: clicking it
// focused no control and the browser could not enforce the field.
//
// What the id does NOT change is the name the control announces. `aria-label`
// outranks an associated `<label for>` in the accessible-name computation, so
// a screen reader still says "Status" rather than the field's own "What do you
// do at UoN?". Fixing that means dropping the aria-label on the native shape
// once it has a label to inherit, which is left alone here because the e2e
// profile step locates this control by `select[aria-label='Status']`: the two
// have to move in one change.
export default function StatusSelect({ id, value, onChange, required }: Props) {
  const options: ResponsiveSelectOption<AffiliationStatus | "">[] = [
    { value: "", label: "Select your status" },
    ...ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
  ];
  return (
    <ResponsiveSelect<AffiliationStatus | "">
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      required={required}
      ariaLabel="Status"
    />
  );
}
