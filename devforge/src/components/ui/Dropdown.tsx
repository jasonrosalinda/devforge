// src/components/ui/Dropdown.tsx
import { useState } from "react";
import { cn } from "../../lib/cn";

type DropdownProps = { label: React.ReactNode; children: React.ReactNode; };

export function Dropdown({ label, children }: DropdownProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block text-left">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex justify-center w-full rounded-md border border-gray-300 px-4 py-2 bg-white text-sm font-medium hover:bg-gray-50 focus:outline-none"
      >
        {label}
      </button>

      <div
        className={cn(
          "absolute mt-2 w-56 rounded-md shadow-lg bg-white ring-1 ring-black ring-opacity-5 z-10 transform transition-all origin-top",
          open ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none"
        )}
      >
        <div className="py-1">{children}</div>
      </div>
    </div>
  );
}
