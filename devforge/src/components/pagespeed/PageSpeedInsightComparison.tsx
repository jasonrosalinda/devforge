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

interface RunMetrics {
  run: number;
  before: Metrics;
  after?: Metrics;
}

interface ValidationErrors {
  apiKey?: string;
  url?: string;
  runs?: string;
}

export default function PageSpeedComparison() {
  const [url, setUrl] = useState("");
  const [runs, setRuns] = useState(1);
  const [metrics, setMetrics] = useState<RunMetrics[]>([]);
  const [currentRun, setCurrentRun] = useState(1);
  const [loadingBefore, setLoadingBefore] = useState(false);
  const [loadingAfter, setLoadingAfter] = useState(false);
  const [beforeCompleted, setBeforeCompleted] = useState(false);
  const [currentAfterRun, setCurrentAfterRun] = useState(0);
  const { showToast } = useToast();
  const [strategy, setStrategy] = useState<string | null>("Mobile");
  const [apiKey, setApiKey] = useState<string>("");

  // Validation states
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const tableRef = useRef<HTMLDivElement>(null);
  const [copyingImage, setCopyingImage] = useState(false);

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

  const validateRuns = (value: number): string | undefined => {
    if (!value || value < 1) {
      return "Number of runs must be at least 1";
    }
    if (value > 10) {
      return "Number of runs cannot exceed 10";
    }
    return undefined;
  };

  const validateField = (
    name: string,
    value: string | number,
  ): string | undefined => {
    switch (name) {
      case "apiKey":
        return validateApiKey(value as string);
      case "url":
        return validateUrl(value as string);
      case "runs":
        return validateRuns(value as number);
      default:
        return undefined;
    }
  };

  const handleBlur = (fieldName: string) => {
    setTouched((prev) => ({ ...prev, [fieldName]: true }));

    let value: string | number = "";
    if (fieldName === "apiKey") value = apiKey;
    else if (fieldName === "url") value = url;
    else if (fieldName === "runs") value = runs;

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

  const handleRunsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value) || 1;
    setRuns(value);

    if (touched.runs) {
      const error = validateRuns(value);
      setErrors((prev) => ({ ...prev, runs: error }));
    }
  };

  const validateAllFields = (): boolean => {
    const newErrors: ValidationErrors = {
      apiKey: validateApiKey(apiKey),
      url: validateUrl(url),
      runs: validateRuns(runs),
    };

    setErrors(newErrors);
    setTouched({ apiKey: true, url: true, runs: true });

    return !Object.values(newErrors).some((error) => error !== undefined);
  };

  // Fetch metrics for a single run
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

  // Fetch before metrics for a single run
  const handleFetchBefore = async () => {
    if (!validateAllFields()) {
      showToast("Please fix validation errors before proceeding", "danger");
      return;
    }

    if (currentRun > runs) return;

    setLoadingBefore(true);
    try {
      const runMetrics = await fetchMetrics(url);
      setMetrics((prev) => [...prev, { run: currentRun, before: runMetrics }]);
      setCurrentRun((prev) => prev + 1);
      if (currentRun === runs) {
        setBeforeCompleted(true);
        showToast(
          "Before metrics completed. Deploy your new release and fetch after metrics.",
          "success",
        );
      }
    } catch (err) {
      console.error(err);
      showToast("Error fetching before metrics", "danger");
    } finally {
      setLoadingBefore(false);
    }
  };

  // Fetch after metrics for all before runs
  const handleFetchAfter = async () => {
    if (!validateAllFields()) {
      showToast("Please fix validation errors before proceeding", "danger");
      return;
    }

    if (!beforeCompleted) return;

    setLoadingAfter(true);
    setCurrentAfterRun(0);
    try {
      const updatedMetrics: RunMetrics[] = [];
      for (let i = 0; i < metrics.length; i++) {
        setCurrentAfterRun(i + 1);
        const after = await fetchMetrics(url);
        updatedMetrics.push({ ...metrics[i], after });
      }
      setMetrics(updatedMetrics);
      showToast("After metrics fetched successfully.", "success");
    } catch (err) {
      console.error(err);
      showToast("Error fetching after metrics", "danger");
    } finally {
      setLoadingAfter(false);
      setCurrentAfterRun(0);
    }
  };

  const handleReset = () => {
    setMetrics([]);
    setCurrentRun(1);
    setBeforeCompleted(false);
    setUrl("");
    setRuns(1);
    setErrors({});
    setTouched({});
    setCurrentAfterRun(0);
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
        scale: 2, // Higher quality
        logging: false,
      });

      // Convert canvas to blob
      canvas.toBlob(async (blob: Blob | null) => {
        if (!blob) {
          showToast("Failed to create image", "danger");
          return;
        }

        try {
          // Copy to clipboard
          await navigator.clipboard.write([
            new ClipboardItem({
              "image/png": blob,
            }),
          ]);
          showToast("Table copied as image to clipboard!", "success");
        } catch (err) {
          console.error("Failed to copy image:", err);

          // Fallback: download the image
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.download = `pagespeed-results-${Date.now()}.png`;
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

  const computeImprovement = (before: number, after?: number) =>
    after !== undefined ? before - after : undefined;
  const improvementPercent = (before: number, after?: number) =>
    after !== undefined ? ((before - after) / before) * 100 : undefined;

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

  return (
    <div className="space-y-12">
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
                  disabled={loadingBefore || loadingAfter}
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
                  disabled={loadingBefore || loadingAfter}
                />
              </div>
              {touched.url && errors.url && (
                <p className="mt-1 text-sm text-red-600">{errors.url}</p>
              )}
            </div>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm/6 font-medium text-black">
              Strategy
            </label>
            <div className="mt-2">
              <div className="flex items-center rounded-md bg-white/5 outline-1 -outline-offset-1 outline-white/10 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-500">
                <DropdownSelect
                  className="w-full"
                  placeholder="Mobile"
                  options={["Desktop", "Mobile"]}
                  onChange={(value) => setStrategy(value)}
                  disabled={loadingBefore || loadingAfter}
                />
              </div>
            </div>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm/6 font-medium text-black">
              Runs <span className="text-red-500">*</span>
            </label>
            <div className="mt-2">
              <div className="flex items-center rounded-md bg-white/5 outline-1 -outline-offset-1 outline-white/10 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-500">
                <Input
                  type="number"
                  min={1}
                  max={10}
                  placeholder="Number of runs"
                  className={cn(
                    "border rounded px-3 py-2 w-full",
                    getInputClassName("runs"),
                  )}
                  value={runs}
                  onChange={handleRunsChange}
                  onBlur={() => handleBlur("runs")}
                  disabled={loadingBefore || loadingAfter}
                />
              </div>
              {touched.runs && errors.runs && (
                <p className="mt-1 text-sm text-red-600">{errors.runs}</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex space-x-2 flex-wrap">
          <LoadingButton
            onClick={handleFetchBefore}
            loadingText={`Fetching Before (Run ${currentRun})...`}
            disabled={loadingBefore || loadingAfter || currentRun > runs}
            className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loadingBefore
              ? `Fetching Before (Run ${currentRun})...`
              : currentRun <= runs
                ? `Fetch Before Metrics (Run ${currentRun})`
                : "Before Metrics Complete"}
          </LoadingButton>

          <LoadingButton
            onClick={handleFetchAfter}
            loadingText={
              currentAfterRun > 0
                ? `Fetching After (Run ${currentAfterRun})...`
                : "Fetching..."
            }
            disabled={
              loadingBefore ||
              loadingAfter ||
              !beforeCompleted ||
              metrics.length === 0 ||
              currentRun <= runs
            }
            className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {loadingAfter
              ? `Fetching After (Run ${currentAfterRun} of ${runs})...`
              : "Fetch After Metrics"}
          </LoadingButton>

          <LoadingButton
            onClick={handleReset}
            disabled={loadingBefore || loadingAfter}
            className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            Reset
          </LoadingButton>
            {metrics.length > 0 && (
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

      {metrics.length > 0 && (
        <div className="mt-6">
          <div ref={tableRef} className="overflow-x-auto bg-white p-4">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">
              Pagespeed Insights Result ({strategy || "Mobile"}):
            </h3>
            <table className="min-w-full divide-y divide-gray-200 border border-gray-300">
              <thead className="bg-gray-800 text-white">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold border-r border-gray-600"></th>
                  <th
                    colSpan={3}
                    className="px-4 py-3 text-center text-sm font-semibold border-r border-gray-600"
                  >
                    Speed Index
                  </th>
                  <th
                    colSpan={3}
                    className="px-4 py-3 text-center text-sm font-semibold border-r border-gray-600"
                  >
                    LCP
                  </th>
                  <th
                    colSpan={3}
                    className="px-4 py-3 text-center text-sm font-semibold"
                  >
                    CLS
                  </th>
                </tr>
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium border-r border-gray-600">
                    Run
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    Before
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    After
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    Improvement
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    Before
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    After
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    Improvement
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    Before
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium border-r border-gray-600">
                    After
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium">
                    Improvement
                  </th>
                </tr>
              </thead>

              <tbody className="bg-white divide-y divide-gray-200">
                {metrics.map((m, idx) => {
                  const siImp = improvementPercent(
                    m.before.speedIndex,
                    m.after?.speedIndex,
                  );
                  const lcpImp = improvementPercent(
                    m.before.largestContentfulPaint,
                    m.after?.largestContentfulPaint,
                  );
                  const clsImp = improvementPercent(
                    m.before.cumulativeLayoutShift,
                    m.after?.cumulativeLayoutShift,
                  );

                  return (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-sm text-gray-900 font-medium border-r border-gray-300">
                        {m.run}
                      </td>

                      {/* Speed Index */}
                      <td className="px-4 py-2 text-sm text-gray-700 text-center border-r border-gray-300">
                        {(m.before.speedIndex / 1000).toFixed(1)}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-700 text-center border-r border-gray-300">
                        {m.after ? (m.after.speedIndex / 1000).toFixed(1) : "-"}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2 text-sm font-semibold text-center border-r border-gray-300",
                          siImp !== undefined && siImp > 0
                            ? "text-green-600"
                            : "text-red-600",
                        )}
                      >
                        {siImp !== undefined ? `${siImp.toFixed(0)}%` : "-"}
                      </td>

                      {/* LCP */}
                      <td className="px-4 py-2 text-sm text-gray-700 text-center border-r border-gray-300">
                        {(m.before.largestContentfulPaint / 1000).toFixed(1)}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-700 text-center border-r border-gray-300">
                        {m.after
                          ? (m.after.largestContentfulPaint / 1000).toFixed(1)
                          : "-"}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2 text-sm font-semibold text-center border-r border-gray-300",
                          lcpImp !== undefined && lcpImp > 0
                            ? "text-green-600"
                            : "text-red-600",
                        )}
                      >
                        {lcpImp !== undefined ? `${lcpImp.toFixed(0)}%` : "-"}
                      </td>

                      {/* CLS */}
                      <td className="px-4 py-2 text-sm text-gray-700 text-center border-r border-gray-300">
                        {m.before.cumulativeLayoutShift.toFixed(3)}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-700 text-center border-r border-gray-300">
                        {m.after
                          ? m.after.cumulativeLayoutShift.toFixed(3)
                          : "-"}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2 text-sm font-semibold text-center",
                          clsImp !== undefined && clsImp > 0
                            ? "text-green-600"
                            : "text-red-600",
                        )}
                      >
                        {clsImp !== undefined ? `${clsImp.toFixed(0)}%` : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
