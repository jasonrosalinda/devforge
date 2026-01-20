import { createContext, useContext, useState, ReactNode } from "react";
import { Toast } from "../components/ui/Toast";

type ToastType = "info" | "success" | "warning" | "danger";

type ToastItem = {
  id: number;
  message: string;
  variant?: ToastType;
};

type ToastContextType = {
  showToast: (message: string, variant?: ToastType) => void;
};

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = (message: string, variant?: ToastType) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, variant }]);
  };

  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      {/* Toast Container */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
        {toasts.map((t) => (
          <Toast
            key={t.id}
            message={t.message}
            variant={t.variant}
            onClose={() => removeToast(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
