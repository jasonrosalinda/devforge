// src/components/ui/Alert.tsx
import { cn } from "../../lib/cn";

type AlertProps = {
  variant?: "info" | "success" | "warning" | "danger";
} & React.HTMLAttributes<HTMLDivElement>;

export function Alert({
  variant = "info",
  className,
  ...props
}: AlertProps) {
  return (
    <div
      className={cn(
        "rounded-md px-4 py-3 text-sm",
        alertStyles[variant],
        className
      )}
      {...props}
    />
  );
}

const alertStyles = {
  info: "bg-blue-50 text-blue-800 border border-blue-200",
  success: "bg-green-50 text-green-800 border border-green-200",
  warning: "bg-yellow-50 text-yellow-800 border border-yellow-200",
  danger: "bg-red-50 text-red-800 border border-red-200",
};
