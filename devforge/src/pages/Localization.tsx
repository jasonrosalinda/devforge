import { useState, useRef } from 'react';
import { Download, Clipboard, Upload, Trash2 } from 'lucide-react';
import DataGrid from '../components/ui/DataGrid';
import { Column, RibbonButton } from '../types/DataGrid.types';
import { useToast } from "../contexts/ToastContext";
import { useConfirm } from '../contexts/ConfirmDialogContext';

interface LocalizationEntry {
  id: number;
  TranslationKey: string;
  ValueEn: string;
  ValueVn: string;
  ValueId: string;
}

export default function Localization() {
  const [data, setData] = useState<LocalizationEntry[]>([]);
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Parse SQL file and extract data
  const parseSqlFile = (sqlContent: string): LocalizationEntry[] => {
    const entries: LocalizationEntry[] = [];
    let currentId = 1;

    // Split by EXEC statements
    const execStatements = sqlContent.split(/EXEC\s+\[dbo\]\.\[sp_InsertUpdateTranslation\]/gi);
    
    // Skip the first element as it's content before the first EXEC
    for (let i = 1; i < execStatements.length; i++) {
      const paramBlock = execStatements[i];
      
      // Extract parameters - handle both single quotes and escaped quotes
      const extractValue = (paramName: string): string => {
        // Match parameter with NULL
        const nullMatch = paramBlock.match(new RegExp(`@${paramName}\\s*=\\s*NULL`, 'i'));
        if (nullMatch) return '';
        
        // Match parameter with value (handles multi-line and escaped quotes)
        const valueMatch = paramBlock.match(new RegExp(`@${paramName}\\s*=\\s*N?'((?:[^']|'')*)'`, 'i'));
        if (valueMatch) {
          // Unescape double single quotes
          return valueMatch[1].replace(/''/g, "'");
        }
        
        return '';
      };

      const translationKey = extractValue('TranslationKey');
      const valueEn = extractValue('Value_EN');
      const valueId = extractValue('Value_ID');
      const valueVn = extractValue('Value_VN');

      // Only add if we have at least a translation key
      if (translationKey) {
        entries.push({
          id: currentId++,
          TranslationKey: translationKey,
          ValueEn: valueEn,
          ValueVn: valueVn,
          ValueId: valueId
        });
      }
    }

    return entries;
  };

  // Handle file upload
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Check file extension
    if (!file.name.toLowerCase().endsWith('.sql')) {
      showToast("Please upload a valid SQL file", "danger");
      return;
    }

    try {
      const fileContent = await file.text();
      const parsedData = parseSqlFile(fileContent);

      if (parsedData.length === 0) {
        showToast("No valid translation entries found in the SQL file", "warning");
        return;
      }

      setData(parsedData);
      showToast(`Successfully loaded ${parsedData.length} translation entries`, "success");
    } catch (error) {
      console.error('Error reading SQL file:', error);
      showToast("Error reading SQL file", "danger");
    } finally {
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Trigger file input click
  const handleUploadClick = () => {
    fileInputRef.current?.click();
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

  // Clear all data
  const handleClearData = async () => {
    if (data.length === 0) {
      showToast("Table is already empty", "info");
      return;
    }

    const confirmed = await confirm({
      title: 'Clear All Data',
      message: `Are you sure you want to clear all ${data.length} entries? This action cannot be undone.`,
      confirmLabel: 'Clear All',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });

    if (confirmed) {
      setData([]);
      showToast("All data cleared successfully", "success");
    }
  };

  // Custom Ribbon Buttons
  const ribbonButtons: RibbonButton[] = [
    {
      label: 'Upload SQL',
      icon: <Upload size={18} />,
      onClick: handleUploadClick,
      variant: 'secondary',
      tooltip: 'Upload SQL File',
      iconOnly: true
    },
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
    },
    {
      label: 'Clear All',
      icon: <Trash2 size={18} />,
      onClick: handleClearData,
      variant: 'danger',
      tooltip: 'Clear All Data',
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
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".sql"
        onChange={handleFileUpload}
        style={{ display: 'none' }}
      />
      
      <DataGrid<LocalizationEntry>
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
    </>
  );
}