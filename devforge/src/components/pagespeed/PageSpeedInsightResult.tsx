import { useState, useRef } from "react";
import { cn } from "../../lib/cn";
import { useToast } from "../../components/ui/contexts/ToastContext";
import LoadingButton from "../../components/ui/LoadingButton";
import Input from "../../components/ui/Input";
import DropdownSelect from "../../components/ui/DropdownSelect";

interface Metrics {
  speedIndex: number;
  largestContentfulPaint: number;
  cumulativeLayoutShift: number;
}

interface ValidationErrors {
  apiKey?: string;
  url?: string;
}

export default function PageSpeedSingleFetch() {
  const [url, setUrl] = useState("");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();
  const [strategy, setStrategy] = useState<string | null>("Mobile");
  const [apiKey, setApiKey] = useState<string>("");
  const tableRef = useRef<HTMLDivElement>(null);
  const [copyingImage, setCopyingImage] = useState(false);

  // Validation states
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Validation functions
  const validateApiKey = (value: string): string | undefined => {
    if (!value.trim()) {
      return "API Key is required";
    }
    if (value.trim().length < 20) {
      return "API Key appears to be invalid";
    }
    return undefined;
  };

  const validateUrl = (value: string): string | undefined => {
    if (!value.trim()) {
      return "URL is required";
    }
    try {
      const urlObj = new URL(value);
      if (!urlObj.protocol.startsWith("http")) {
        return "URL must start with http:// or https://";
      }
    } catch {
      return "Please enter a valid URL";
    }
    return undefined;
  };

  const validateField = (name: string, value: string): string | undefined => {
    switch (name) {
      case "apiKey":
        return validateApiKey(value);
      case "url":
        return validateUrl(value);
      default:
        return undefined;
    }
  };

  const handleBlur = (fieldName: string) => {
    setTouched((prev) => ({ ...prev, [fieldName]: true }));

    let value = "";
    if (fieldName === "apiKey") value = apiKey;
    else if (fieldName === "url") value = url;

    const error = validateField(fieldName, value);
    setErrors((prev) => ({ ...prev, [fieldName]: error }));
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setApiKey(value);

    if (touched.apiKey) {
      const error = validateApiKey(value);
      setErrors((prev) => ({ ...prev, apiKey: error }));
    }
  };

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setUrl(value);

    if (touched.url) {
      const error = validateUrl(value);
      setErrors((prev) => ({ ...prev, url: error }));
    }
  };

  const validateAllFields = (): boolean => {
    const newErrors: ValidationErrors = {
      apiKey: validateApiKey(apiKey),
      url: validateUrl(url),
    };

    setErrors(newErrors);
    setTouched({ apiKey: true, url: true });

    return !Object.values(newErrors).some((error) => error !== undefined);
  };

  // Fetch metrics
  const fetchMetrics = async (url: string): Promise<Metrics> => {
    const strategyParam = strategy ? `&strategy=${strategy}` : "";

    const res = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}${strategyParam}`,
    );
    const data = await res.json();
    const audits = data?.lighthouseResult?.audits;

    return {
      speedIndex: audits?.["speed-index"]?.numericValue || 0,
      largestContentfulPaint:
        audits?.["largest-contentful-paint"]?.numericValue || 0,
      cumulativeLayoutShift:
        audits?.["cumulative-layout-shift"]?.numericValue || 0,
    };
  };

  // Fetch metrics
  const handleFetch = async () => {
    if (!validateAllFields()) {
      showToast("Please fix validation errors before proceeding", "danger");
      return;
    }

    setLoading(true);
    try {
      const result = await fetchMetrics(url);
      setMetrics(result);
      showToast("Metrics fetched successfully", "success");
    } catch (err) {
      console.error(err);
      showToast("Error fetching metrics", "danger");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setMetrics(null);
    setUrl("");
    setErrors({});
    setTouched({});
  };

  const getInputClassName = (
    fieldName: keyof ValidationErrors,
    baseClassName: string = "",
  ) => {
    const hasError = touched[fieldName] && errors[fieldName];
    const isValid = touched[fieldName] && !errors[fieldName];

    let className = baseClassName;
    if (hasError) {
      className += " border-red-500 focus:border-red-500 focus:ring-red-500";
    } else if (isValid) {
      className +=
        " border-green-500 focus:border-green-500 focus:ring-green-500";
    }
    return className;
  };

  const copyTableAsImage = async () => {
    if (!tableRef.current) return;

    setCopyingImage(true);
    try {
      // Load html2canvas from CDN if not already loaded
      if (!(window as any).html2canvas) {
        const script = document.createElement("script");
        script.src =
          "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        script.async = true;

        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const html2canvas = (window as any).html2canvas;

      // Create canvas from the table element
      const canvas = await html2canvas(tableRef.current, {
        backgroundColor: "#ffffff",
        scale: 2,
        logging: false,
      });

      // Convert canvas to blob
      canvas.toBlob(async (blob: Blob | null) => {
        if (!blob) {
          showToast("Failed to create image", "danger");
          return;
        }

        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              "image/png": blob,
            }),
          ]);
          showToast("Table copied as image to clipboard!", "success");
        } catch (err) {
          console.error("Failed to copy image:", err);

          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.download = `pagespeed-result-${Date.now()}.png`;
          link.href = url;
          link.click();
          URL.revokeObjectURL(url);
          showToast("Image downloaded (clipboard not supported)", "success");
        }
      }, "image/png");
    } catch (err) {
      console.error("Error creating image:", err);
      showToast("Error creating image", "danger");
    } finally {
      setCopyingImage(false);
    }
  };

  return (
    <div>
      <div className="space-y-2">
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-6">
          <div className="sm:col-span-4">
            <label
              htmlFor="api-key"
              className="block text-sm/6 font-medium text-black"
            >
              API Key <span className="text-red-500">*</span>
            </label>
            <div className="mt-2">
              <div className="flex items-center rounded-md bg-white/5 outline-1 -outline-offset-1 outline-white/10 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-500">
                <Input
                  id="api-key"
                  type="text"
                  placeholder="API Key"
                  value={apiKey}
                  onChange={handleApiKeyChange}
                  onBlur={() => handleBlur("apiKey")}
                  className={getInputClassName("apiKey")}
                  disabled={loading}
                />
              </div>
              {touched.apiKey && errors.apiKey && (
                <p className="mt-1 text-sm text-red-600">{errors.apiKey}</p>
              )}
            </div>
          </div>

          <div className="sm:col-span-full">
            <label
              htmlFor="web-page-url"
              className="block text-sm/6 font-medium text-black"
            >
              Web Page URL <span className="text-red-500">*</span>
            </label>
            <div className="mt-2">
              <div className="flex items-center rounded-md bg-white/5 outline-1 -outline-offset-1 outline-white/10 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-500">
                <Input
                  id="web-page-url"
                  type="text"
                  placeholder="Enter a web page URL (https://example.com)"
                  value={url}
                  onChange={handleUrlChange}
                  onBlur={() => handleBlur("url")}
                  className={getInputClassName("url")}
                  disabled={loading}
                />
              </div>
              {touched.url && errors.url && (
                <p className="mt-1 text-sm text-red-600">{errors.url}</p>
              )}
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-sm/6 font-medium text-black">
              Strategy
            </label>
            <div className="mt-2">
              <div className="flex items-center rounded-md bg-white/5 outline-1 -outline-offset-1 outline-white/10 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-500">
                <DropdownSelect
                  className="w-full"
                  placeholder="Mobile"
                  options={["Desktop & Mobile", "Desktop", "Mobile"]}
                  onChange={(value) => setStrategy(value)}
                  disabled={loading}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex space-x-2 flex-wrap">
          <LoadingButton
            onClick={handleFetch}
            loadingText="Fetching..."
            disabled={loading}
            className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Fetching..." : "Fetch Metrics"}
          </LoadingButton>

          <LoadingButton
            onClick={handleReset}
            disabled={loading}
            className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            Reset
          </LoadingButton>

          {metrics && (
            <LoadingButton
              onClick={copyTableAsImage}
              disabled={copyingImage}
              loadingText="Copying..."
              className="px-4 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {copyingImage ? "Copying..." : "Copy as Image"}
            </LoadingButton>
          )}
        </div>
      </div>

      {metrics && (
        <div className="mt-6">
          <div ref={tableRef} className="overflow-x-auto bg-white p-4">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">
              Pagespeed Insights Result ({strategy || "Mobile"}):
            </h3>
            <table className="min-w-full divide-y divide-gray-200 border border-gray-300">
              <thead className="bg-gray-800 text-white">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold border-r border-gray-600">
                    Metric
                  </th>
                  <th className="px-4 py-3 text-center text-sm font-semibold">
                    Value
                  </th>
                </tr>
              </thead>

              <tbody className="bg-white divide-y divide-gray-200">
                {/* Speed Index */}
                <tr className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-sm text-gray-900 font-medium border-r border-gray-300">
                    Speed Index
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-700 text-center">
                    {(metrics.speedIndex / 1000).toFixed(1)}s
                  </td>
                </tr>

                {/* LCP */}
                <tr className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-sm text-gray-900 font-medium border-r border-gray-300">
                    Largest Contentful Paint (LCP)
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-700 text-center">
                    {(metrics.largestContentfulPaint / 1000).toFixed(1)}s
                  </td>
                </tr>

                {/* CLS */}
                <tr className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-sm text-gray-900 font-medium border-r border-gray-300">
                    Cumulative Layout Shift (CLS)
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-700 text-center">
                    {metrics.cumulativeLayoutShift.toFixed(3)}ms
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
