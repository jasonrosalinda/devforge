import PageSpeedComparison from "../components/pagespeed/PageSpeedInsightComparison";
import PageSpeedInsightResult from "../components/pagespeed/PageSpeedInsightResult";
import { Card, CardBody, CardHeader } from "../components/ui";

export default function PageSpeedMobileMetrics() {
  return (
    <div className="space-y-12">
      <div>
        <Card className="mt-6">
          <CardHeader className="text-2xl rounded-t-lg bg-gray-900 font-bold text-white">Single PageSpeed Insight</CardHeader>
          <CardBody>
            <PageSpeedInsightResult />
          </CardBody>
        </Card>
      </div>

      <div>
        <Card className="mt-6">
             <CardHeader className="text-2xl rounded-t-lg bg-gray-900 font-bold text-white">PageSpeed Insights Comparison</CardHeader>
          <CardBody>
            <PageSpeedComparison />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
