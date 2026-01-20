export interface CheckOption {
    id: string | number;
    label: string;
}

export interface DropdownChecklistProps {
    title: string;
    options: CheckOption[];
    selectedValues: (string | number)[];
    onChange: (selected: (string | number)[]) => void;
}