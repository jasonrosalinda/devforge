import PageSpeedComparison from "../components/pagespeed/PageSpeedInsightComparison";
import PageSpeedInsightResult from "../components/pagespeed/PageSpeedInsightResult";
import { Card, CardBody, CardHeader } from "../components/ui";

export default function PageSpeedMobileMetrics() {
  return (
    <div className="space-y-12">
      <div>
        <h2 className="text-2xl font-bold text-gray-800">PageSpeed Insights</h2>
        <p className="text-gray-600 mt-1">
          Analyze mobile performance metrics for your web pages.
        </p>
        <Card className="mt-6">
          <CardBody>
            <PageSpeedInsightResult />
          </CardBody>
        </Card>
      </div>

      <div>
        <h2 className="text-2xl font-bold text-gray-800">
          PageSpeed Insights Comparison
        </h2>
        <p className="text-gray-600 mt-1">
          Analyze and compare performance metrics for your web pages.
        </p>
        <Card className="mt-6">
          <CardBody>
            <PageSpeedComparison />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
