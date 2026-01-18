// src/components/ui/Toast.tsx
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";

type ToastProps = {
  message: string;
  variant?: "info" | "success" | "warning" | "danger";
  duration?: number; 
  onClose: () => void;
};

export function Toast({
  message,
  variant = "info",
  duration = 3000,
  onClose,
}: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300); // wait for fade out
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const variantStyles = {
    info: "bg-blue-50 text-blue-800 border-blue-200",
    success: "bg-green-50 text-green-800 border-green-200",
    warning: "bg-yellow-50 text-yellow-800 border-yellow-200",
    danger: "bg-red-50 text-red-800 border-red-200",
  };

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 px-4 py-3 border rounded shadow transform transition-all",
        variantStyles[variant],
        visible ? "opacity-100 translate-y-0 duration-300" : "opacity-0 translate-y-4 duration-300"
      )}
    >
      {message}
    </div>
  );
}
