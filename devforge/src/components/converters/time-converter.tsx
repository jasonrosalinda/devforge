import { Clock, Globe, ArrowRight, Calendar, RotateCcw, ArrowLeftRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTimeConverter } from '@/hooks/useTimeConverter';
import { TIMEZONES } from '@/types/timeConverter.types';
import TimezoneList from './timezone-list';

export default function TimeConverter() {
    const {
        useCustomTime,
        customDate,
        customTime,
        sourceTimezone,
        targetTimezone,
        sourceTime,
        targetTime,
        timeDifference,
        timeDiffText,
        convertedTimezones,
        handleSourceTimezoneChange,
        handleTargetTimezoneChange,
        handleDateChange,
        handleTimeChange,
        swapTimezones,
        resetToCurrentTime,
        formatTime,
        formatDate,
    } = useTimeConverter();

    return (
        <div className="w-full">
            <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-20px); }
        }
        
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        .animate-float {
          animation: float 6s ease-in-out infinite;
        }
        
        .animate-fadeIn {
          animation: fadeIn 0.8s ease-out forwards;
        }
        
        .stagger-1 { animation-delay: 0.1s; }
        .stagger-2 { animation-delay: 0.2s; }
        .stagger-3 { animation-delay: 0.3s; }
        .stagger-4 { animation-delay: 0.4s; }
      `}</style>

            <div className="flex items-start gap-4 w-full">
                {/* Source Timezone Card */}
                <Card className="flex-1">
                    <CardHeader className="pb-4">
                        <Select
                            value={sourceTimezone.id}
                            onValueChange={handleSourceTimezoneChange}
                        >
                            <SelectTrigger className="bg-slate-800/50 border-amber-800/30 text-amber-50 h-12 text-base font-light">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-900 border-amber-800/30">
                                {TIMEZONES.map((tz) => (
                                    <SelectItem
                                        key={tz.id}
                                        value={tz.id}
                                        className="text-amber-50 focus:bg-amber-900/30 focus:text-amber-50 font-light"
                                    >
                                        <div className="flex flex-col items-start">
                                            <span className="font-medium">{tz.name}</span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </CardHeader>
                    <CardContent>
                        <div className="grid sm:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="custom-date">
                                    Date
                                </Label>
                                <Input
                                    id="custom-date"
                                    type="date"
                                    value={customDate}
                                    onChange={(e) => handleDateChange(e.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="custom-time">
                                    Time
                                </Label>
                                <Input
                                    id="custom-time"
                                    type="time"
                                    value={customTime}
                                    onChange={(e) => handleTimeChange(e.target.value)}
                                />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Arrow Icon */}
                <div className="flex items-center justify-center pt-12">
                    <Button
                        variant="outline"
                        size="icon"
                        onClick={swapTimezones}
                        className="rounded-full"
                    >
                        <ArrowLeftRight className="w-4 h-4" />
                    </Button>
                </div>

                {/* Target Timezone Card */}
                <Card className="flex-1">
                    <CardHeader className="pb-4">
                        <Select value={targetTimezone.id} onValueChange={handleTargetTimezoneChange}>
                            <SelectTrigger className="bg-slate-800/50 border-amber-800/30 text-amber-50 h-12 text-base font-light">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-900 border-amber-800/30">
                                {TIMEZONES.map((tz) => (
                                    <SelectItem
                                        key={tz.id}
                                        value={tz.id}
                                        className="text-amber-50 focus:bg-amber-900/30 focus:text-amber-50 font-light"
                                    >
                                        <div className="flex flex-col items-start">
                                            <span className="font-medium">{tz.name}</span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </CardHeader>
                    <CardContent>
                        <div className="grid sm:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="target-date">
                                    Date
                                </Label>
                                <Input
                                    id="target-date"
                                    type="date"
                                    value={targetTime.toISOString().split('T')[0]}
                                    readOnly
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="target-time">
                                    Time
                                </Label>
                                <Input
                                    id="target-time"
                                    type="time"
                                    value={formatTime(targetTime)}
                                    readOnly
                                />
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Time Difference Info */}
            <div className="text-center mt-6">
                <div className="inline-block backdrop-blur-sm border rounded-full px-6 py-3">
                    <p className="text-sm font-light">
                        <span className="font-medium">{timeDiffText}</span>
                        {timeDifference > 0 && (
                            <span className="ml-2">
                                · {targetTimezone.name} is {targetTimezone.offset > sourceTimezone.offset ? 'ahead of' : 'behind'} {sourceTimezone.name}
                            </span>
                        )}
                    </p>
                </div>
            </div>

            {/* All Timezones List */}
            <div className="mt-8">
                <TimezoneList
                    sourceTimezone={sourceTimezone}
                    convertedTimezones={convertedTimezones}
                />
            </div>
        </div>
    );
}