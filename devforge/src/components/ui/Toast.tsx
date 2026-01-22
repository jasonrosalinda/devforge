import { toast, type ExternalToast } from "sonner";

type ToastProps = {
    success: (message: string) => void;
    info: (message: string) => void;
    warning: (message: string) => void;
    error: (message: string) => void;
    promise: <T>(
        promise: Promise<T>,
        messages: {
            loading: string;
            success: string | ((data: T) => string);
            error: string | ((error: any) => string);
        }
    ) => (string & { unwrap: () => Promise<T> }) | (number & { unwrap: () => Promise<T> }) | { unwrap: () => Promise<T> };
};

export const Toast = (): ToastProps => {
    const externalToast: ExternalToast = { position: "bottom-right" };

    const success = (message: string) => {
        toast.success(message, externalToast);
    };

    const info = (message: string) => {
        toast.info(message, externalToast);
    };

    const warning = (message: string) => {
        toast.warning(message, externalToast);
    };

    const error = (message: string) => {
        toast.error(message, externalToast);
    };

    const promise = <T,>(
        promiseToResolve: Promise<T>,
        messages: {
            loading: string;
            success: string | ((data: T) => string);
            error: string | ((error: any) => string);
        }
    ) => {
        return toast.promise(
            promiseToResolve,
            {
                loading: messages.loading,
                success: messages.success,
                error: messages.error,
                ...externalToast
            }
        );
    };

    return {
        success,
        info,
        warning,
        error,
        promise,
    };
};