import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { CheckOption, DropdownChecklistProps } from '../../types/dropDownChecklist.types';

const DropdownChecklist: React.FC<DropdownChecklistProps> = ({
    title,
    options,
    selectedValues,
    onChange,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const toggleOption = (id: string | number) => {
        const isSelected = selectedValues.includes(id);
        const newSelected = isSelected
            ? selectedValues.filter((item) => item !== id)
            : [...selectedValues, id];

        onChange(newSelected);
    };

    return (
        <div className="relative inline-block w-64 text-left" ref={dropdownRef}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center justify-between w-full px-4 py-2 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none"
            >
                <span className="truncate">
                    {selectedValues.length > 0
                        ? `${title} (${selectedValues.length})`
                        : title}
                </span>
                <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute z-10 w-full mt-2 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                    <div className="p-2 space-y-1">
                        {options.map((option) => {
                            const isChecked = selectedValues.includes(option.id);
                            return (
                                <label
                                    key={option.id}
                                    className="flex items-center px-3 py-2 text-sm transition-colors rounded-md cursor-pointer hover:bg-gray-50"
                                >
                                    <input
                                        type="checkbox"
                                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                        checked={isChecked}
                                        onChange={() => toggleOption(option.id)}
                                    />
                                    <span className="ml-3 text-gray-700">{option.label}</span>
                                </label>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default DropdownChecklist;