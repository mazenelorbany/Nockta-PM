// ============================================================================
// Reusable bits
// ============================================================================

export function Field({ label, children, required, optional }: { label: string; children: React.ReactNode; required?: boolean; optional?: boolean }): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
        {optional && <span className="ml-1 text-muted-foreground">(optional)</span>}
      </span>
      {children}
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}
