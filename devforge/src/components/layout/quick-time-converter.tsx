import { useState } from "react"
import { ArrowRightLeft, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogTrigger,
} from "@/components/ui/dialog"

type Direction = "utcToLocal" | "localToUtc"

function toInputValue(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function QuickTimeConverter() {
    const [direction, setDirection] = useState<Direction>("utcToLocal")
    const [inputValue, setInputValue] = useState(() => toInputValue(new Date()))

    const [datePart, timePart] = inputValue.split("T")
    const [year, month, day] = (datePart ?? "").split("-").map(Number)
    const [hours, minutes] = (timePart ?? "").split(":").map(Number)

    const isValid = [year, month, day, hours, minutes].every((n) => Number.isFinite(n))

    const sourceDate = isValid
        ? direction === "utcToLocal"
            ? new Date(Date.UTC(year!, month! - 1, day!, hours!, minutes!))
            : new Date(year!, month! - 1, day!, hours!, minutes!)
        : null

    const formatOptions: Intl.DateTimeFormatOptions = {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }

    const resultLabel = direction === "utcToLocal" ? "Local time" : "UTC time"
    const resultText = sourceDate
        ? direction === "utcToLocal"
            ? sourceDate.toLocaleString([], formatOptions)
            : sourceDate.toLocaleString([], { ...formatOptions, timeZone: "UTC" })
        : "—"

    const swapDirection = () => {
        setDirection((d) => (d === "utcToLocal" ? "localToUtc" : "utcToLocal"))
    }

    return (
        <Dialog>
            <Hint label="Convert between UTC and local time">
                <DialogTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    >
                        <Clock className="w-4 h-4" />
                    </Button>
                </DialogTrigger>
            </Hint>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Quick Time Converter</DialogTitle>
                    <DialogDescription>
                        Convert between UTC and your local timezone.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                        {direction === "utcToLocal" ? "UTC" : "Local"} in
                    </Label>
                    <Hint label="Swap the conversion direction">
                        <Button variant="ghost" size="sm" onClick={swapDirection} className="h-7 px-2 text-xs gap-1">
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                            Swap
                        </Button>
                    </Hint>
                </div>

                <Input
                    type="datetime-local"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                />

                <div className="rounded-md border bg-muted/40 p-3">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        {resultLabel}
                    </div>
                    <div className="text-base font-semibold tabular-nums">{resultText}</div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
