import React from 'react';

interface CheckboxProps {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    id?: string;
    disabled?: boolean;
}

const Checkbox: React.FC<CheckboxProps> = ({
    label,
    checked,
    onChange,
    id,
    disabled = false
}) => {
    const checkboxId = id || label.replace(/\s+/g, '-').toLowerCase();

    return (
        <label
            htmlFor={checkboxId}
            className={`flex items-center space-x-3 cursor-pointer group ${disabled ? 'opacity-50 cursor-not-allowed' : ''
                }`}
        >
            <div className="relative flex items-center">
                {/* Hidden Native Checkbox */}
                <input
                    id={checkboxId}
                    type="checkbox"
                    className="peer sr-only" // sr-only hides it but keeps it accessible
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.checked)}
                />

                {/* Styled Custom Box */}
                <div className={`
          w-5 h-5 border-2 rounded transition-all duration-200 flex items-center justify-center
          ${checked
                        ? 'bg-blue-600 border-blue-600'
                        : 'bg-white border-gray-300 group-hover:border-blue-400'
                    }
          peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2
        `}>
                    {/* Checkmark Icon (Lucide-react or SVG) */}
                    <svg
                        className={`w-3.5 h-3.5 text-white transition-transform duration-200 ${checked ? 'scale-100' : 'scale-0'
                            }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={4}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                </div>
            </div>

            {/* Label Text */}
            <span className={`select-none text-sm font-medium ${checked ? 'text-gray-900' : 'text-gray-600'
                }`}>
                {label}
            </span>
        </label>
    );
};

export default Checkbox;