import { useMemo } from "react";
import { FleetPulse } from "@/components/home/fleetPulseView";

interface HomePageProps {
    onNavigate?: (pageTitle: string) => void;
    /** Home is the visible tab — the pulse only refreshes then. */
    active?: boolean;
}

function greetingFor(hour: number): string {
    return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export default function HomePage({ onNavigate = () => { }, active = true }: HomePageProps) {
    const greeting = useMemo(() => greetingFor(new Date().getHours()), []);

    return (
        <div className="flex w-full flex-col gap-6">
            <div className="border-b pb-4">
                <h1 className="text-xl font-semibold tracking-tight">{greeting}</h1>
            </div>
            <FleetPulse active={active} onNavigate={onNavigate} />
        </div>
    );
}
