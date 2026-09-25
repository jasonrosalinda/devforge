import { useEffect, useState } from "react"

interface ClockDisplay {
    time: string;
    date: string;
}

function useClockForZone(timeZone: string): ClockDisplay {
    const [display, setDisplay] = useState<ClockDisplay>({ time: "", date: "" });

    useEffect(() => {
        const update = () => {
            const now = new Date();
            setDisplay({
                time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone }),
                date: now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone }),
            });
        };
        update();
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [timeZone]);

    return display;
}

/** One zone per row: time + zone label on the left, date on the right. */
function ClockRow({ time, date, label }: ClockDisplay & { label: string }) {
    return (
        <div className="flex items-baseline gap-1.5 whitespace-nowrap leading-none">
            <span className="text-sm font-semibold tabular-nums">{time}</span>
            <span className="w-10 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/60">{label}</span>
            <span className="ml-auto truncate text-[11px] text-sidebar-foreground/60">{date}</span>
        </div>
    );
}

/** Local + UTC clocks at the foot of the sidebar. Hidden when collapsed to the icon rail. */
export function SidebarClocks() {
    const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localLabel = new Intl.DateTimeFormat([], { timeZoneName: "short", timeZone: localTimeZone })
        .formatToParts(new Date())
        .find(p => p.type === "timeZoneName")?.value ?? localTimeZone;

    const local = useClockForZone(localTimeZone);
    const utc = useClockForZone("UTC");

    return (
        <div className="flex flex-col gap-2 px-2 py-1.5">
            <ClockRow {...local} label={localLabel} />
            <ClockRow {...utc} label="UTC" />
        </div>
    );
}
