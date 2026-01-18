// src/components/ui/Card.tsx
import { cn } from "../../lib/cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border bg-white shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("border-b px-4 py-3 font-semibold", className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("px-4 py-3 text-sm text-gray-700", className)}
      {...props}
    />
  );
}

export function CardFooter({className,...props}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`border-t px-4 py-3 text-right ${className ?? ""}`}
      {...props}
    />
  );
}
