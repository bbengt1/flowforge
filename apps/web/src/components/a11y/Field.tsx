"use client";

import {
  cloneElement,
  isValidElement,
  useId,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  fieldControlAria,
  fieldDescriptionIds,
  fieldMarksInvalid,
  type FieldControlAria,
} from "@/lib/a11y-field";

export type FieldProps = {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Point at a shared FieldError when this field does not render the text. */
  errorId?: string;
  showError?: boolean;
  invalid?: boolean;
  required?: boolean;
  className?: string;
  labelClassName?: string;
  hintClassName?: string;
  errorClassName?: string;
  errorStyle?: CSSProperties;
  controlPlacement?: "after-label" | "before-label";
  "data-ndv-field"?: string;
  "data-ndv-parameter-control"?: string;
  children: ReactNode | ((control: FieldControlAria) => ReactNode);
};

export function Field({
  id: idProp,
  label,
  hint,
  error,
  errorId,
  showError = true,
  invalid,
  required = false,
  className = "block text-sm",
  labelClassName = "font-medium",
  hintClassName = "mt-1 block text-xs text-fg",
  errorClassName = "mt-1 block text-sm text-danger",
  errorStyle,
  controlPlacement = "after-label",
  "data-ndv-field": dataNdvField,
  "data-ndv-parameter-control": dataNdvParameterControl,
  children,
}: FieldProps) {
  const generatedId = useId();
  const id = idProp?.trim() || generatedId;
  const hasHint = hint != null && hint !== false && hint !== "";
  const hasError = error != null && error !== false && error !== "";
  const described = fieldDescriptionIds({
    id,
    hasHint,
    hasError: hasError || Boolean(errorId),
    errorId,
  });
  const control = fieldControlAria({
    id,
    invalid: fieldMarksInvalid({
      invalid,
      hasError: hasError || Boolean(errorId),
    }),
    describedBy: described.describedBy,
    required,
  });
  const controlProps = {
    id: control.id,
    "aria-invalid": control["aria-invalid"],
    "aria-describedby": control["aria-describedby"],
    "aria-required": control["aria-required"],
    required: control.required,
  };
  const controlNode =
    typeof children === "function"
      ? children(control)
      : isValidElement(children)
        ? cloneElement(
            children as ReactElement<Record<string, unknown>>,
            controlProps,
          )
        : children;

  return (
    <label
      htmlFor={id}
      className={className}
      data-ndv-field={dataNdvField}
      data-ndv-parameter-control={dataNdvParameterControl}
    >
      {controlPlacement === "before-label" ? controlNode : null}
      <span className={labelClassName}>{label}</span>
      {controlPlacement === "after-label" ? controlNode : null}
      {hasHint ? (
        <span id={described.hintId} className={hintClassName}>
          {hint}
        </span>
      ) : null}
      {hasError && showError ? (
        <span
          id={described.errorId}
          role="alert"
          className={errorClassName}
          style={errorStyle}
        >
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function FieldError({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul id={id} role="alert" className={className}>
      {children}
    </ul>
  );
}
