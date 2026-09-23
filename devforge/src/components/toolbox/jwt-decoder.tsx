import { useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { decodeJwt, timeClaims } from "@/lib/toolbox/jwt";
import { CopyButton, ErrorNote, OutputBox, ToolPanel } from "./toolbox-shared";

const STATE_VARIANT = {
    valid: "secondary",
    expired: "destructive",
    "not-yet-valid": "outline",
} as const;

export default function JwtDecoder() {
    const [token, setToken] = useState("");

    const decoded = useMemo(() => decodeJwt(token), [token]);
    const claims = useMemo(() => timeClaims(decoded.payload), [decoded.payload]);

    const headerText = decoded.header ? JSON.stringify(decoded.header, null, 2) : "";
    const payloadText = decoded.payload ? JSON.stringify(decoded.payload, null, 2) : "";
    const showErrors = token.trim().length > 0 && decoded.errors.length > 0;

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <Textarea
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste a JWT — header.payload.signature"
                spellCheck={false}
                className="font-mono text-xs h-24 resize-none"
            />

            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                Decoded only. The signature is never verified — that needs the issuer's key.
            </p>

            {showErrors && decoded.errors.map((error) => <ErrorNote key={error}>{error}</ErrorNote>)}

            {claims.length > 0 && (
                <div className="rounded-md border divide-y">
                    {claims.map((claim) => (
                        <div key={claim.claim} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                            <span className="w-24 shrink-0 font-medium">
                                {claim.label} <span className="text-muted-foreground">({claim.claim})</span>
                            </span>
                            <span className="tabular-nums">{claim.local}</span>
                            <span className="tabular-nums text-muted-foreground">{claim.utc} UTC</span>
                            <Badge variant={STATE_VARIANT[claim.state]} className="ml-auto font-normal">
                                {claim.relative}
                            </Badge>
                        </div>
                    ))}
                </div>
            )}

            <div className="grid gap-3 md:grid-cols-2 flex-1 min-h-0">
                <ToolPanel title="Header" actions={<CopyButton value={headerText} label="Copy header" />}>
                    <OutputBox value={headerText} placeholder="Header appears here" />
                </ToolPanel>
                <ToolPanel title="Payload" actions={<CopyButton value={payloadText} label="Copy payload" />}>
                    <OutputBox value={payloadText} placeholder="Payload appears here" />
                </ToolPanel>
            </div>

            {decoded.signature && (
                <ToolPanel title="Signature" actions={<CopyButton value={decoded.signature} label="Copy signature" />}>
                    <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono break-all">
                        {decoded.signature}
                    </p>
                </ToolPanel>
            )}
        </div>
    );
}
