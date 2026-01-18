// src/components/ui/Input.tsx
import { cn } from "../../lib/cn";
import { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export default function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none",
        className
      )}
      {...props} // <-- spreads all native input props including onChange, value, placeholder
    />
  );
}