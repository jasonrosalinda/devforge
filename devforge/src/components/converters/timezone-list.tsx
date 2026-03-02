import { Clock, MapPin } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type Timezone } from '@/types/timeConverter.types';
import { type ConvertedTimezone } from '@/hooks/useTimeConverter';

interface TimezoneListProps {
    sourceTimezone: Timezone;
    convertedTimezones: ConvertedTimezone[];
}

export default function TimezoneList({
    sourceTimezone,
    convertedTimezones,
}: TimezoneListProps) {

    const getDayLabel = (dayDiff: number): string => {
        if (dayDiff === 0) return 'Same day';
        if (dayDiff === 1) return '+1 day';
        if (dayDiff === -1) return '-1 day';
        if (dayDiff > 1) return `+${dayDiff} days`;
        return `${dayDiff} days`;
    };

    return (
        <Card className="w-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Clock className="w-5 h-5" />
                    All Timezones
                </CardTitle>
                <CardDescription>
                    Converted times for all timezones based on {sourceTimezone.name}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {convertedTimezones.map(({ timezone, formattedTime, formattedDate, dayDifference }) => (
                        <div
                            key={timezone.id}
                            className={`
                                p-4 rounded-lg border transition-all duration-200
                                hover:shadow-lg hover:scale-105 cursor-pointer
                                ${timezone.id === sourceTimezone.id
                                    ? 'bg-amber-900/20 border-amber-600/50 ring-2 ring-amber-500/30'
                                    : 'bg-slate-800/30 border-slate-700/50 hover:border-amber-600/30'
                                }
                            `}
                        >
                            {/* Timezone Name */}
                            <div className="flex items-start justify-between mb-2">
                                <h3 className="font-semibold text-sm text-amber-50">
                                    {timezone.name}
                                </h3>
                                {timezone.id === sourceTimezone.id && (
                                    <span className="text-xs bg-amber-600/30 text-amber-300 px-2 py-0.5 rounded-full">
                                        Source
                                    </span>
                                )}
                            </div>

                            {/* Time Display */}
                            <div className="mb-3">
                                <div className="text-2xl font-bold text-amber-100 tabular-nums">
                                    {formattedTime}
                                </div>
                                {dayDifference !== 0 && (
                                    <div className="text-xs text-amber-400/70 mt-1">
                                        {getDayLabel(dayDifference)}
                                    </div>
                                )}
                            </div>

                            {/* Date */}
                            <div className="text-xs text-slate-400 mb-2">
                                {formattedDate}
                            </div>

                            {/* Cities */}
                            <div className="flex items-start gap-1 text-xs text-slate-500">
                                <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                <span className="line-clamp-2">{timezone.cities}</span>
                            </div>

                            {/* UTC Offset */}
                            <div className="mt-2 pt-2 border-t border-slate-700/50">
                                <span className="text-xs text-slate-500">
                                    UTC{timezone.offset >= 0 ? '+' : ''}{timezone.offset}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
