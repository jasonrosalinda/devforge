import { useState, useEffect, useMemo, useCallback } from 'react';
import { type Timezone, TIMEZONES } from '../types/timeConverter.types';

export interface ConvertedTimezone {
    timezone: Timezone;
    date: Date;
    formattedTime: string;
    formattedDate: string;
    dayDifference: number;
}

export const useTimeConverter = () => {
    const [currentTime, setCurrentTime] = useState(new Date());
    const [useCustomTime, setUseCustomTime] = useState(false);
    const [customDate, setCustomDate] = useState('');
    const [customTime, setCustomTime] = useState('');
    const [sourceTimezone, setSourceTimezone] = useState<Timezone>(TIMEZONES[0]!);
    const [targetTimezone, setTargetTimezone] = useState<Timezone>(TIMEZONES[1]!);

    // Update current time every second when not using custom time
    useEffect(() => {
        if (!useCustomTime) {
            const timer = setInterval(() => {
                setCurrentTime(new Date());
            }, 1000);
            return () => clearInterval(timer);
        }
    }, [useCustomTime]);

    // Initialize with current date and time
    useEffect(() => {
        const now = new Date();
        setCustomDate(now.toISOString().split('T')[0] ?? '');
        setCustomTime(now.toTimeString().slice(0, 5));
    }, []);

    const getBaseTime = (): Date => {
        if (useCustomTime && customDate && customTime) {
            // Parse custom date and time
            const [year, month, day] = customDate.split('-').map(Number);
            const [hours, minutes] = customTime.split(':').map(Number);
            return new Date(year!, month! - 1, day!, hours!, minutes!, 0);
        }
        return currentTime;
    };

    const getTimeForTimezone = (timezone: Timezone): Date => {
        const baseTime = getBaseTime();
        // If using custom time, treat it as being in the source timezone
        if (useCustomTime) {
            // Convert from source timezone to target timezone
            const sourceOffset = sourceTimezone.offset;
            const targetOffset = timezone.offset;
            const offsetDiff = (targetOffset - sourceOffset) * 3600000;
            return new Date(baseTime.getTime() + offsetDiff);
        }
        // For current time, convert from local time to timezone
        const utc = baseTime.getTime() + baseTime.getTimezoneOffset() * 60000;
        return new Date(utc + timezone.offset * 3600000);
    };

    const formatTime = (date: Date): string => {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    };

    const formatDate = (date: Date): string => {
        return date.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    };

    const swapTimezones = useCallback(() => {
        const temp = sourceTimezone;
        setSourceTimezone(targetTimezone);
        setTargetTimezone(temp);
    }, [sourceTimezone, targetTimezone]);

    const resetToCurrentTime = useCallback(() => {
        setUseCustomTime(false);
        const now = new Date();
        setCustomDate(now.toISOString().split('T')[0] ?? '');
        setCustomTime(now.toTimeString().slice(0, 5));
    }, []);

    const handleDateChange = useCallback((value: string) => {
        setCustomDate(value);
        setUseCustomTime(true);
    }, []);

    const handleTimeChange = useCallback((value: string) => {
        setCustomTime(value);
        setUseCustomTime(true);
    }, []);

    // Safe timezone setter for source - with fallback to current timezone
    const handleSourceTimezoneChange = useCallback((id: string) => {
        const timezone = TIMEZONES.find(tz => tz.id === id);
        if (timezone) {
            setSourceTimezone(timezone);
        }
    }, []);

    // Safe timezone setter for target - with fallback to current timezone
    const handleTargetTimezoneChange = useCallback((id: string) => {
        const timezone = TIMEZONES.find(tz => tz.id === id);
        if (timezone) {
            setTargetTimezone(timezone);
        }
    }, []);

    // Memoize calculated times to prevent infinite re-renders
    const sourceTime = useMemo(() => getTimeForTimezone(sourceTimezone), [
        currentTime,
        useCustomTime,
        customDate,
        customTime,
        sourceTimezone,
        targetTimezone,
    ]);

    const targetTime = useMemo(() => getTimeForTimezone(targetTimezone), [
        currentTime,
        useCustomTime,
        customDate,
        customTime,
        sourceTimezone,
        targetTimezone,
    ]);

    const timeDifference = useMemo(() =>
        Math.abs(targetTimezone.offset - sourceTimezone.offset),
        [targetTimezone.offset, sourceTimezone.offset]
    );

    const timeDiffText = useMemo(() => {
        if (timeDifference === 0) return 'Same time';
        return `${timeDifference} hour${timeDifference !== 1 ? 's' : ''} ${targetTimezone.offset > sourceTimezone.offset ? 'ahead' : 'behind'
            }`;
    }, [timeDifference, targetTimezone.offset, sourceTimezone.offset]);

    // Convert all timezones based on source timezone and input date/time
    const convertedTimezones = useMemo((): ConvertedTimezone[] => {
        const baseTime = getBaseTime();
        const baseDate = baseTime.getDate();

        return TIMEZONES.map(timezone => {
            // Calculate time difference from source timezone
            const offsetDiff = (timezone.offset - sourceTimezone.offset) * 3600000; // Convert to milliseconds
            const convertedDate = new Date(baseTime.getTime() + offsetDiff);

            // Calculate day difference
            const dayDifference = convertedDate.getDate() - baseDate;

            return {
                timezone,
                date: convertedDate,
                formattedTime: convertedDate.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                }),
                formattedDate: convertedDate.toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                }),
                dayDifference,
            };
        });
    }, [sourceTimezone, customDate, customTime, currentTime, useCustomTime]);


    return {
        // State
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

        // Setters - use these instead of setSourceTimezone/setTargetTimezone directly
        handleSourceTimezoneChange,
        handleTargetTimezoneChange,
        handleDateChange,
        handleTimeChange,

        // Actions
        swapTimezones,
        resetToCurrentTime,

        // Utilities
        formatTime,
        formatDate,
    };
};