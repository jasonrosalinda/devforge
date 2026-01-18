// src/components/ui/Modal.tsx
import { cn } from "../../lib/cn";
import { ReactNode, useEffect, useState } from "react";

type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
};

export function Modal({ isOpen, onClose, children, title }: ModalProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) setShow(true);
  }, [isOpen]);

  if (!isOpen && !show) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-black/50 transition-opacity",
        isOpen ? "opacity-100 duration-300" : "opacity-0 duration-200"
      )}
      onClick={onClose}
    >
      <div
        className={cn(
          "bg-white rounded-lg shadow-lg max-w-lg w-full transform transition-transform",
          isOpen ? "scale-100 duration-300" : "scale-95 duration-200"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="px-4 py-3 border-b font-semibold text-lg">{title}</div>
        )}
        <div className="p-4">{children}</div>
        <div className="px-4 py-3 border-t flex justify-end">
          <button
            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
