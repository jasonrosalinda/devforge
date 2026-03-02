export interface Timezone {
    id: string;
    name: string;
    offset: number; // UTC offset in hours
    cities: string;
}

export const TIMEZONES: Timezone[] = [
    // UTC-12 to UTC-10
    { id: 'utc-12', name: 'UTC-12', offset: -12, cities: 'Baker Island · Howland Island' },
    { id: 'utc-11', name: 'UTC-11', offset: -11, cities: 'American Samoa · Niue' },
    { id: 'utc-10', name: 'UTC-10 (HST)', offset: -10, cities: 'Honolulu · Tahiti · Rarotonga' },

    // UTC-9 to UTC-8
    { id: 'utc-9:30', name: 'UTC-9:30', offset: -9.5, cities: 'Marquesas Islands' },
    { id: 'utc-9', name: 'UTC-9 (AKST)', offset: -9, cities: 'Anchorage · Juneau · Fairbanks' },
    { id: 'utc-8', name: 'UTC-8 (PST)', offset: -8, cities: 'Los Angeles · San Francisco · Seattle · Vancouver' },

    // UTC-7 to UTC-6
    { id: 'utc-7', name: 'UTC-7 (MST)', offset: -7, cities: 'Denver · Phoenix · Calgary · Salt Lake City' },
    { id: 'utc-6', name: 'UTC-6 (CST)', offset: -6, cities: 'Chicago · Mexico City · Dallas · Guatemala City' },

    // UTC-5 to UTC-4
    { id: 'utc-5', name: 'UTC-5 (EST)', offset: -5, cities: 'New York · Toronto · Miami · Lima · Bogotá' },
    { id: 'utc-4', name: 'UTC-4 (AST)', offset: -4, cities: 'Halifax · Caracas · La Paz · Santiago · San Juan' },

    // UTC-3:30 to UTC-3
    { id: 'utc-3:30', name: 'UTC-3:30 (NST)', offset: -3.5, cities: 'St. John\'s · Newfoundland' },
    { id: 'utc-3', name: 'UTC-3', offset: -3, cities: 'São Paulo · Buenos Aires · Montevideo · Brasília' },

    // UTC-2 to UTC
    { id: 'utc-2', name: 'UTC-2', offset: -2, cities: 'South Georgia · South Sandwich Islands' },
    { id: 'utc-1', name: 'UTC-1', offset: -1, cities: 'Cape Verde · Azores' },
    { id: 'utc', name: 'UTC', offset: 0, cities: 'Coordinated Universal Time · Greenwich' },
    { id: 'gmt', name: 'GMT', offset: 0, cities: 'London · Dublin · Lisbon · Reykjavik · Accra' },

    // UTC+1 to UTC+2
    { id: 'utc+1', name: 'UTC+1 (CET)', offset: 1, cities: 'Paris · Berlin · Rome · Madrid · Amsterdam · Brussels' },
    { id: 'utc+2', name: 'UTC+2 (EET)', offset: 2, cities: 'Athens · Cairo · Helsinki · Bucharest · Johannesburg' },

    // UTC+3 to UTC+3:30
    { id: 'utc+3', name: 'UTC+3', offset: 3, cities: 'Moscow · Istanbul · Riyadh · Nairobi · Baghdad' },
    { id: 'utc+3:30', name: 'UTC+3:30', offset: 3.5, cities: 'Tehran' },

    // UTC+4 to UTC+4:30
    { id: 'utc+4', name: 'UTC+4 (GST)', offset: 4, cities: 'Dubai · Abu Dhabi · Muscat · Baku · Tbilisi' },
    { id: 'utc+4:30', name: 'UTC+4:30', offset: 4.5, cities: 'Kabul' },

    // UTC+5 to UTC+5:45
    { id: 'utc+5', name: 'UTC+5', offset: 5, cities: 'Karachi · Tashkent · Yekaterinburg' },
    { id: 'utc+5:30', name: 'UTC+5:30 (IST)', offset: 5.5, cities: 'Mumbai · Delhi · Bangalore · Colombo · Kolkata' },
    { id: 'utc+5:45', name: 'UTC+5:45', offset: 5.75, cities: 'Kathmandu' },

    // UTC+6 to UTC+6:30
    { id: 'utc+6', name: 'UTC+6', offset: 6, cities: 'Dhaka · Almaty · Bishkek · Thimphu' },
    { id: 'utc+6:30', name: 'UTC+6:30', offset: 6.5, cities: 'Yangon · Cocos Islands' },

    // UTC+7 to UTC+8
    { id: 'utc+7', name: 'UTC+7', offset: 7, cities: 'Bangkok · Hanoi · Jakarta · Ho Chi Minh City' },
    { id: 'utc+8', name: 'UTC+8', offset: 8, cities: 'Singapore · Hong Kong · Manila · Beijing · Perth · Taipei' },

    // UTC+8:45 to UTC+9
    { id: 'utc+8:45', name: 'UTC+8:45', offset: 8.75, cities: 'Eucla' },
    { id: 'utc+9', name: 'UTC+9 (JST)', offset: 9, cities: 'Tokyo · Seoul · Osaka · Pyongyang' },

    // UTC+9:30 to UTC+10
    { id: 'utc+9:30', name: 'UTC+9:30 (ACST)', offset: 9.5, cities: 'Adelaide · Darwin' },
    { id: 'utc+10', name: 'UTC+10 (AEST)', offset: 10, cities: 'Sydney · Melbourne · Brisbane · Port Moresby' },

    // UTC+10:30 to UTC+11
    { id: 'utc+10:30', name: 'UTC+10:30', offset: 10.5, cities: 'Lord Howe Island' },
    { id: 'utc+11', name: 'UTC+11', offset: 11, cities: 'Noumea · Solomon Islands · Magadan' },

    // UTC+12 to UTC+12:45
    { id: 'utc+12', name: 'UTC+12', offset: 12, cities: 'Auckland · Fiji · Kamchatka · Marshall Islands' },
    { id: 'utc+12:45', name: 'UTC+12:45', offset: 12.75, cities: 'Chatham Islands' },

    // UTC+13 to UTC+14
    { id: 'utc+13', name: 'UTC+13', offset: 13, cities: 'Nuku\'alofa · Apia · Tokelau' },
    { id: 'utc+14', name: 'UTC+14', offset: 14, cities: 'Kiritimati · Line Islands' },
];