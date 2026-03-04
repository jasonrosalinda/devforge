import { isElectron } from "@/lib/environment";
import { Monitor, Globe } from "lucide-react";

export const AccessMode = () => {
    const desktop = isElectron();

    return (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
            {desktop ? (
                <Monitor className="w-3 h-3" />
            ) : (
                <Globe className="w-3 h-3" />
            )}
        </span>
    )
}