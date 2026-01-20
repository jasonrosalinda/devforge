import { useState } from "react";
import { COUNTRY_LIST } from "../utils/constants";
import { Column, RibbonButton } from "../types/DataGrid.types";
import DataGrid from "../components/ui/DataGrid";
import { DatabaseZap, Upload } from "lucide-react";
import { useToast } from "../contexts/ToastContext";
import DropdownSelect from "../components/ui/DropdownSelect";
import { ApiResult } from "../types/Results.types";
import { CardModule } from "../components/ui/CardModule";

interface CacheEntry {
  id: number;
  key: string;
  description: string;
  byCountry: boolean;
  byIndex: boolean;
  param: string;
  mandatoryParam: boolean;
}

interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  state: "info" | "success" | "warning" | "danger";
}

function createCacheEntry(
  entry: Omit<CacheEntry, "mandatoryParam">,
): CacheEntry {
  return {
    ...entry,
    mandatoryParam: entry.byCountry || entry.byIndex,
  };
}

export default function MEDUCache() {
  const { showToast } = useToast();
  const [env, setEnv] = useState("UAT");
  const [evnt, setEvnt] = useState<LogEntry[]>([]);
  const [data, setData] = useState<CacheEntry[]>([
    createCacheEntry({
      id: 1,
      key: "course-listing:countryCode-{0}",
      description: "Cache for Course listing",
      byCountry: true,
      byIndex: false,
      param: "",
    }),
    createCacheEntry({
      id: 2,
      key: "course-index:{0}",
      description: "Cache for Course",
      byCountry: false,
      byIndex: true,
      param: "",
    }),
    createCacheEntry({
      id: 3,
      key: "webinar-listing:countryCode-{0}",
      description: "Cache for Webinar listing",
      byCountry: true,
      byIndex: false,
      param: "",
    }),
    createCacheEntry({
      id: 4,
      key: "webinar-index:{0}",
      description: "Cache for Webinar",
      byCountry: false,
      byIndex: true,
      param: "",
    }),
    createCacheEntry({
      id: 5,
      key: "enrollmentcontroller.getenrolledcoursesasync-{0}",
      description: "Cache for User Enrollment",
      byCountry: false,
      byIndex: true,
      param: "",
    }),
    createCacheEntry({
      id: 6,
      key: "page.configurations",
      description: "Cache for Page Configurations",
      byCountry: false,
      byIndex: false,
      param: "",
    }),
  ]);

  const columns: Column<CacheEntry>[] = [
    {
      key: "key",
      label: "Cache Key",
      type: "text",
      editable: false,
      sortable: true,
    },
    {
      key: "description",
      label: "Description",
      type: "text",
      sortable: true,
    },
    {
      key: "param",
      label: "Parameter",
      type: "text",
      editable: (row) => row.mandatoryParam,
      defaultValue: "",
      sortable: false,
    },
  ];

  const addEvent = (
    message: string,
    state: "info" | "success" | "warning" | "danger",
  ) => {
    const timestamp = new Date().toISOString();
    setEvnt((prev) => [
      ...prev,
      { id: prev.length + 1, timestamp, message, state },
    ]);
  };

  const handleClearCache = async (row: CacheEntry) => {
    if (env === "") {
      showToast("Please select an environment.", "warning");
      return;
    }

    let fullKey = row.key;
    if (row.mandatoryParam && row.param) {
      if (row.byCountry) {
        if (row.param === "*") {
          for (const country of COUNTRY_LIST) {
            let replacedKey = fullKey.replace(
              "{0}",
              country.code.toLowerCase(),
            );
            await postClearCache(replacedKey);
          }
          return;
        }
        const exists = COUNTRY_LIST.some(
          (c) => c.code === row.param.toUpperCase(),
        );
        if (exists) {
          fullKey = fullKey.replace("{0}", row.param.toLowerCase());
        } else {
          addEvent(`Invalid country code: ${row.param}`, "danger");
          return;
        }
      } else {
        fullKey = fullKey.replace("{0}", row.param);
      }
    }

    await postClearCache(fullKey);
  };

  const postClearCache = async (key: string) => {
    const domainPrefix = env !== "PRD" ? `${env.toLowerCase()}-` : ``;

    const url = `https://${domainPrefix}meduapi.mims.com/api/cacheentry/${key}`;

    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        addEvent(`${url} => failed to clear cache. Status: ${res.status} | ${text}`, "danger");
        return;
      }
    } catch (error) {
      addEvent(`${url} => network or CORS error while clearing cache for key: ${key}`, "danger");
      return;
    }

    addEvent(`${url} => successfully cleared cache`, "success");
  };

  // Handle editing row
  const handleEdit = (id: number | string, updatedRow: CacheEntry) => {
    setData(data.map((row) => (row.id === id ? updatedRow : row)));
  };

  return (
    <CardModule
      header={
        <div className="flex items-end flex-1 justify-end">
          <select value={env} onChange={(e) => setEnv(e.target.value)}
            className="w-32 px-3 py-2 border border-gray-700 bg-gray-800 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-gray-800">
            <option value="SIT">SIT</option>
            <option value="UAT">UAT</option>
            <option value="STG">STG</option>
            <option value="PRD">PRD</option>
          </select>
        </div>
      }
      body={
        <>
          <DataGrid
            columns={columns}
            data={data}
            showDefaultActions={{ add: false, edit: true, delete: false }}
            onEdit={handleEdit}
            rowActions={[
              {
                label: "Clear Cache",
                icon: <DatabaseZap size={18} />,
                hidden: (row) => row.mandatoryParam && !row.param,
                onClick: (row) => handleClearCache(row),
                variant: "danger",
              },
            ]}
          />

          {evnt.length > 0 && (
            <div className="mt-4 p-4 border rounded bg-gray-900">
              <h3 className="font-medium mb-2 text-white">Events Triggered:</h3>
              <ul className="list-disc list-inside overflow-y-auto max-h-40">
                {evnt.map((e, index) => (
                  <li
                    className={`mb-1 ${e.state == "info" ? "text-blue-300" : e.state == "success" ? "text-green-300" : e.state == "warning" ? "text-yellow-300" : "text-red-300"}`}
                    key={e.id}
                  >
                    {e.timestamp}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      }>
    </CardModule>
  );
}
