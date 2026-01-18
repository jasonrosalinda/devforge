import { useState } from 'react';
import { Download, Clipboard } from 'lucide-react';
import DataGrid from '../components/ui/DataGrid';
import { Column, RibbonButton } from '../components/ui/types/DataGrid.types';
import { useToast } from "../components/ui/contexts/ToastContext";

interface LocalizationEntry {
  id: number;
  TranslationKey: string;
  ValueEn: string;
  ValueVn: string;
  ValueId: string;
}

export default function DataManagement() {
  const [data, setData] = useState<LocalizationEntry[]>([]);
  const { showToast } = useToast();

  // Define table columns
  const columns: Column<LocalizationEntry>[] = [
    {
      key: 'TranslationKey',
      label: 'Translation Key',
      type: 'text',
      editable: true,
      placeholder: 'Enter translation key',
      defaultValue: '',
      sortable: true
    },
    {
      key: 'ValueEn',
      label: 'English (EN)',
      type: 'text',
      editable: true,
      placeholder: 'Enter English translation',
      defaultValue: '',
      sortable: true
    },
    {
      key: 'ValueVn',
      label: 'Vietnamese (VN)',
      type: 'text',
      editable: true,
      placeholder: 'Enter Vietnamese (VN) translation',
      defaultValue: '',
      sortable: true
    },
    {
      key: 'ValueId',
      label: 'Indonesian (ID)',
      type: 'text',
      editable: true,
      placeholder: 'Enter Indonesian translation',
      defaultValue: '',
      sortable: true
    }
  ];

  // SQL Configuration
  const sqlConfig = {
    storedProcedure: 'sp_InsertUpdateTranslation',
    parameterMapping: {
      'TranslationKey': 'TranslationKey' as keyof LocalizationEntry,
      'Value_EN': 'ValueEn' as keyof LocalizationEntry,
      'Value_ID': 'ValueId' as keyof LocalizationEntry,
      'Value_VN': 'ValueVn' as keyof LocalizationEntry
    },
    formatValue: (key: string, value: any) => value
  };

  // Generate SQL Script
  const generateSqlScript = () => {
    if (!sqlConfig) return '';

    const { 
      storedProcedure, 
      parameterMapping, 
      formatValue
    } = sqlConfig;

    let script = '';

    data.forEach((row) => {
      script += `EXEC [dbo].[${storedProcedure}]\n`;
      
      // Add parameters
      Object.entries(parameterMapping).forEach(([paramName, columnKey], idx) => {
        const value = row[columnKey];
        const formattedValue = formatValue(columnKey, value);
        
        // Handle different value types
        let sqlValue: string;
        if (formattedValue === null || formattedValue === undefined || formattedValue === '') {
          sqlValue = 'NULL';
        } else if (typeof formattedValue === 'string') {
          // Escape single quotes and wrap in N'' for NVARCHAR
          sqlValue = `N'${formattedValue.replace(/'/g, "''")}'`;
        } else if (typeof formattedValue === 'number') {
          sqlValue = String(formattedValue);
        } else {
          sqlValue = `N'${String(formattedValue).replace(/'/g, "''")}'`;
        }

        const isLast = idx === Object.entries(parameterMapping).length - 1;
        script += `    @${paramName} = ${sqlValue}${isLast ? ';' : ','}\n`;
      });

      script += '\n';
    });

    return script;
  };

  // Download SQL Script
  const onDownloadSql = () => {
    const script = generateSqlScript();
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Translations.sql`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Copy SQL Script to Clipboard
  const onCopySql = async () => {
    const script = generateSqlScript();
    try {
      await navigator.clipboard.writeText(script);
      showToast("SQL script copied to clipboard!", "info");
    } catch (err) {
      showToast("Failed to copy SQL script", "danger");
    }
  };

  // Custom Ribbon Buttons
  const ribbonButtons: RibbonButton[] = [
    {
      label: 'Download SQL',
      icon: <Download size={18} />,
      onClick: () => onDownloadSql(),
      variant: 'primary',
      tooltip: 'Download SQL Script',
      iconOnly: true
    },
    {
      label: 'Copy SQL',
      icon: <Clipboard size={18} />,
      onClick: () => onCopySql(),
      variant: 'primary',
      tooltip: 'Copy SQL Script',
      iconOnly: true
    }
  ];

  // Handle adding new row
  const handleAdd = (newRow: Partial<LocalizationEntry>) => {
    const newId = Math.max(...data.map(d => d.id), 0) + 1;
    setData([...data, { id: newId, ...newRow } as LocalizationEntry]);
  };

  // Handle editing row
  const handleEdit = (id: number | string, updatedRow: LocalizationEntry) => {
    setData(data.map(row => row.id === id ? updatedRow : row));
  };

  // Handle deleting row
  const handleDelete = (id: number | string) => {
    setData(data.filter(row => row.id !== id));
  };

  return (
    <DataGrid<LocalizationEntry>
      title="Localization Management"
      description="Manage localization entries with DataGrid"
      columns={columns}
      data={data}
      onAdd={handleAdd}
      onEdit={handleEdit}
      onDelete={handleDelete}
      enablePagination={true}
      pageSize={10}
      enableSorting={true}
      ribbonButtons={ribbonButtons}
    />
  );
}