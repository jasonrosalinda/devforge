// src/components/ui/Dropdown.tsx
import { useState, useRef, useEffect, ReactNode } from "react";
import { cn } from "../../lib/cn";

type DropdownProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
};

type DropdownItemProps = {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
};

export function Dropdown({ label, children, className }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLButtonElement[]>([]);
  const [focusIndex, setFocusIndex] = useState(-1);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
        setFocusIndex(-1);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = itemsRef.current;
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIndex = (focusIndex + 1) % items.length;
      setFocusIndex(nextIndex);
      items[nextIndex].focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevIndex = (focusIndex - 1 + items.length) % items.length;
      setFocusIndex(prevIndex);
      items[prevIndex].focus();
    }
    if (e.key === "Escape") {
      setOpen(false);
      setFocusIndex(-1);
    }
  };

  // Add refs to children
  const childrenWithRefs = (children as ReactNode[]).map((child: any, index) =>
    child ? (
      <child.type
        {...child.props}
        ref={(el: HTMLButtonElement) => (itemsRef.current[index] = el)}
        onClick={() => {
          setOpen(false);
          setFocusIndex(-1);
          child.props.onClick?.();
        }}
      />
    ) : null
  );

  return (
    <div className={cn("relative inline-block text-left", className)} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex justify-center w-full rounded-md border border-gray-300 px-4 py-2 bg-white text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
      >
        {label}
      </button>

      <div
        className={cn(
          "absolute mt-2 w-56 rounded-md shadow-lg bg-white ring-1 ring-black ring-opacity-5 z-10 transform transition-all origin-top",
          open ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none"
        )}
        onKeyDown={handleKeyDown}
      >
        <div className="py-1">{childrenWithRefs}</div>
      </div>
    </div>
  );
}

export const DropdownItem = ({ children, onClick, className }: DropdownItemProps, ref?: any) => {
  return (
    <button
      ref={ref}
      onClick={onClick}
      className={cn(
        "block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none",
        className
      )}
    >
      {children}
    </button>
  );
};
